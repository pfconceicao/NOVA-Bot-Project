// tst5_generateJSON_incremental.mjs
import fs from "fs";
import path from "path";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import { pipeline } from "@xenova/transformers";

// ───────── CONFIGURAÇÃO ─────────
const pdfFolder = path.resolve("./docs");         // PDFs originais
const outputFolder = path.resolve("./index_docs"); // JSONs de saída
const chunkSize = 1000; // caracteres
const overlap = 200;

// Cria pasta de saída se não existir
if (!fs.existsSync(outputFolder)) fs.mkdirSync(outputFolder, { recursive: true });

// ───────── EXTRAIR TEXTO DO PDF ─────────
async function extractTextFromPDF(filePath) {
  const data = new Uint8Array(await fs.promises.readFile(filePath));
  const pdf = await pdfjsLib.getDocument({ data }).promise;
  let text = "";
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map(it => it.str).join(" ") + "\n";
  }
  return text;
}

// ───────── CHUNKING ─────────
function chunkText(text) {
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

// ───────── SCRIPT PRINCIPAL ─────────
async function main() {
  const pdfFiles = fs.readdirSync(pdfFolder).filter(f => f.endsWith(".pdf"));
  console.log("PDFs encontrados:", pdfFiles);

  // Inicializar modelo de embeddings
  console.log("🧠 A carregar modelo de embeddings...");
  const embedder = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", { pooling: "mean", normalize: true });
  console.log("✅ Modelo carregado");

  for (const file of pdfFiles) {
    const jsonFileName = file.replace(/\.pdf$/, ".json");
    const outFile = path.join(outputFolder, jsonFileName);

    // Se já existe JSON, pula o PDF
    if (fs.existsSync(outFile)) {
      console.log(`⏩ Ignorado (JSON já existe): ${file}`);
      continue;
    }

    console.log(`\n📄 Processando: ${file}`);
    const text = await extractTextFromPDF(path.join(pdfFolder, file));
    const chunks = chunkText(text);
    console.log(`   🔢 ${chunks.length} chunks gerados`);

    const chunkObjects = [];
    for (const [i, chunk] of chunks.entries()) {
      try {
        const embeddingTensor = await embedder(chunk);
        const embedding = Array.from(embeddingTensor.data);
        chunkObjects.push({ text: chunk, embedding });
        console.log(`     ✅ Chunk ${i + 1} embedding gerado`);
      } catch (err) {
        console.error(`     ❌ Erro no chunk ${i + 1}:`, err);
      }
    }

    fs.writeFileSync(outFile, JSON.stringify(chunkObjects, null, 2));
    console.log(`   💾 JSON guardado em ${outFile}`);
  }

  console.log("\n🎉 Processamento incremental concluído!");
}

main().catch(console.error);
