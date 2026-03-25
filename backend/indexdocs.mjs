// indexdocs.mjs
// ───────── Ingestão de PDFs + geração de NDJSON com embeddings + hyperlinks por página ─────────

import fs from "fs";
import path from "path";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import { pipeline } from "@xenova/transformers";

// ───────── CONFIGURAÇÃO ─────────
const pdfFolder = path.resolve("./docs");
const outputFolder = path.resolve("./index_docs");
const modelPath = "Xenova/all-MiniLM-L6-v2";

const CHUNK_SIZE = 1000;
const OVERLAP = 200;

// proteção: evita textos absurdos (alguns PDFs geram lixo gigante)
const MAX_TEXT_LENGTH = 2_000_000; // 2M chars por PDF (ajustável)

// ───────── FUNÇÕES UTIL ─────────
function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function walkDir(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkDir(full));
    else out.push(full);
  }
  return out;
}

function safeNameFromRelative(relPath) {
  return relPath
    .replaceAll("\\", "/")
    .replace(/\.pdf$/i, "")
    .replaceAll("/", "__")
    .replace(/[^\w\-_.]+/g, "_");
}

function categoryFromRelativePath(relPath) {
  const parts = relPath.replaceAll("\\", "/").split("/");
  return parts.length > 1 ? parts[0] : "root";
}

function chunkText(text, chunkSize = CHUNK_SIZE, overlap = OVERLAP) {
  const chunks = [];
  let start = 0;

  while (start < text.length) {
    const end = start + chunkSize;
    chunks.push(text.slice(start, end));
    start = end - overlap;
    if (start < 0) start = 0;
  }
  return chunks;
}

// ───────── EXTRAÇÃO DE TEXTO POR PÁGINA ─────────
async function extractPagesFromPDF(filePath) {
  const data = new Uint8Array(await fs.promises.readFile(filePath));
  const pdf = await pdfjsLib.getDocument({ data }).promise;

  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items.map(it => it.str).join(" ").trim();
    pages.push({ pageNumber: i, text: pageText });
  }

  return { numPages: pdf.numPages, pages };
}

// ───────── EXTRAÇÃO DE HIPERLINKS (ANOTAÇÕES) POR PÁGINA ─────────
async function extractLinksByPageFromPDF(filePath) {
  const data = new Uint8Array(await fs.promises.readFile(filePath));
  const pdf = await pdfjsLib.getDocument({ data }).promise;

  const linksByPage = new Map(); // pageNumber -> urls[]

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const annotations = await page.getAnnotations();

    const urls = annotations
      .map(a => a?.url || a?.action?.URI || a?.a?.URI || null)
      .filter(Boolean);

    linksByPage.set(i, [...new Set(urls)]);
  }

  return linksByPage;
}

// ───────── MAIN ─────────
async function main() {
  ensureDir(outputFolder);

  const allFiles = walkDir(pdfFolder);
  const pdfFiles = allFiles.filter(f => f.toLowerCase().endsWith(".pdf"));

  if (!pdfFiles.length) {
    console.log("⚠️ Nenhum PDF encontrado na pasta ./docs (incluindo subpastas)");
    return;
  }

  console.log(`📄 PDFs encontrados: ${pdfFiles.length}`);

  console.log("🧠 A carregar modelo de embeddings...");
  const embedder = await pipeline("feature-extraction", modelPath, {
    pooling: "mean",
    normalize: true
  });
  console.log("✅ Modelo carregado");

  for (const filePath of pdfFiles) {
    const rel = path.relative(pdfFolder, filePath).replaceAll("\\", "/");
    const category = categoryFromRelativePath(rel);
    const sourcePdf = path.basename(filePath);

    console.log(`\n📄 Processando: ${rel}`);

    // 1) texto por página
    const { pages } = await extractPagesFromPDF(filePath);

    // se não houver texto útil, ignora
    const totalTextLen = pages.reduce((sum, p) => sum + (p.text?.length || 0), 0);
    if (!totalTextLen) {
      console.log("⚠️ Sem texto extraído (PDF pode ser scan/OCR necessário)");
      continue;
    }

    // proteção contra PDFs enormes: truncar no total (mantendo páginas iniciais)
    let running = 0;
    const trimmedPages = [];
    for (const p of pages) {
      if (!p.text) continue;
      if (running >= MAX_TEXT_LENGTH) break;

      const remaining = MAX_TEXT_LENGTH - running;
      const t = p.text.length > remaining ? p.text.slice(0, remaining) : p.text;
      running += t.length;
      trimmedPages.push({ pageNumber: p.pageNumber, text: t });
    }

    if (totalTextLen > MAX_TEXT_LENGTH) {
      console.log(`⚠️ Texto extraído enorme (${totalTextLen}). Truncado para ${MAX_TEXT_LENGTH}.`);
    }

    // 2) hyperlinks por página (anotações)
    const linksByPage = await extractLinksByPageFromPDF(filePath);

    // 3) criar chunks preservando pageNumber e urls
    const chunks = [];
    for (const p of trimmedPages) {
      const pageText = (p.text || "").trim();
      if (!pageText) continue;

      const parts = chunkText(pageText);
      const urls = linksByPage.get(p.pageNumber) || [];

      for (const part of parts) {
        chunks.push({
          text: part,
          pageNumber: p.pageNumber,
          urls
        });
      }
    }

    console.log(`   🔢 Texto total (após truncagem): ${running} caracteres`);
    console.log(`   🧩 Nº de chunks: ${chunks.length}`);

    const safeName = safeNameFromRelative(rel);
    const outFile = path.join(outputFolder, `${safeName}.ndjson`);
    const ws = fs.createWriteStream(outFile, { encoding: "utf-8" });

    for (let i = 0; i < chunks.length; i++) {
      const ch = chunks[i];

      const embeddingTensor = await embedder(ch.text);
      const embedding = Array.from(embeddingTensor.data);

      const row = {
        chunkIndex: i,
        text: ch.text,
        embedding,
        sourcePdf,
        relativePath: rel,
        category,
        pageNumber: ch.pageNumber,
        meta: { urls: ch.urls }
      };

      ws.write(JSON.stringify(row) + "\n");
    }

    await new Promise((resolve, reject) => {
      ws.end(resolve);
      ws.on("error", reject);
    });

    console.log(`💾 Index guardado em: ${outFile}`);
  }
}

main().catch(console.error);