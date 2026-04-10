import fs from "fs";
import path from "path";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";

const outputFolder = path.resolve("./data/doc-diffs");
const OLLAMA_HOST = process.env.OLLAMA_HOST || "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_SUPPORT_MODEL || process.env.OLLAMA_MODEL || "mistral";
const OLLAMA_TIMEOUT_MS = Number.parseInt(
  process.env.OLLAMA_SUPPORT_TIMEOUT_MS || process.env.OLLAMA_TIMEOUT_MS || "120000",
  10
);
const MAX_DOC_CHARS = 7000;

function safeFileToken(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[:/\\\s]+/g, "-")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "model";
}

function timestampToken(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${year}${month}${day}-${hours}${minutes}${seconds}`;
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

async function readPdfText(filePath) {
  const data = new Uint8Array(await fs.promises.readFile(filePath));
  const pdf = await pdfjsLib.getDocument({ data }).promise;
  const pages = [];

  for (let index = 1; index <= pdf.numPages; index++) {
    const page = await pdf.getPage(index);
    const content = await page.getTextContent();
    const text = content.items.map((item) => item.str).join(" ").trim();
    if (text) pages.push(`[[PAGE:${index}]] ${text}`);
  }

  return pages.join("\n\n");
}

async function readDocumentText(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".pdf") return readPdfText(filePath);
  return fs.readFileSync(filePath, "utf-8");
}

function trimText(text, maxChars = MAX_DOC_CHARS) {
  return String(text ?? "").replace(/\s+/g, " ").trim().slice(0, maxChars);
}

async function callOllama(prompt) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);

  const response = await fetch(`${OLLAMA_HOST}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      prompt,
      stream: false,
      options: {
        temperature: 0.1,
        num_predict: 700,
      },
    }),
    signal: controller.signal,
  }).finally(() => clearTimeout(timer));

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Ollama HTTP ${response.status} ${response.statusText} ${text}`);
  }

  const data = await response.json();
  return String(data?.response ?? "").trim();
}

function extractJsonObject(raw) {
  const text = String(raw ?? "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}

function buildPrompt({ oldName, newName, oldText, newText }) {
  return `
És um assistente de apoio à manutenção de um chatbot académico.

Compara dois documentos e identifica apenas mudanças relevantes para atualização do bot.

Devolve APENAS JSON válido com esta estrutura:
{
  "summary": "resumo curto em português",
  "changes": [
    {
      "type": "novo|alterado|removido",
      "topic": "tema afetado",
      "impact": "como isto pode afetar respostas, FAQs ou fluxos do bot"
    }
  ]
}

Regras:
- Foca-te em alterações práticas: prazos, custos, documentos, contactos, elegibilidade, procedimentos e links.
- Se não houver alterações relevantes, devolve changes como array vazio.
- Não incluas markdown nem texto fora do JSON.

Documento antigo: ${oldName}
${oldText}

Documento novo: ${newName}
${newText}
`.trim();
}

async function main() {
  ensureDir(outputFolder);

  const oldPath = process.argv[2];
  const newPath = process.argv[3];

  if (!oldPath || !newPath) {
    console.log("Uso: npm run docs:compare -- <ficheiro-antigo> <ficheiro-novo>");
    process.exitCode = 1;
    return;
  }

  const resolvedOldPath = path.resolve(oldPath);
  const resolvedNewPath = path.resolve(newPath);

  if (!fs.existsSync(resolvedOldPath) || !fs.existsSync(resolvedNewPath)) {
    throw new Error("Um dos ficheiros indicados não existe.");
  }

  const oldText = trimText(await readDocumentText(resolvedOldPath));
  const newText = trimText(await readDocumentText(resolvedNewPath));

  if (!oldText || !newText) {
    throw new Error("Não foi possível extrair texto útil de um dos documentos.");
  }

  console.log(`📄 A comparar ${path.basename(resolvedOldPath)} -> ${path.basename(resolvedNewPath)}`);

  const raw = await callOllama(buildPrompt({
    oldName: path.basename(resolvedOldPath),
    newName: path.basename(resolvedNewPath),
    oldText,
    newText,
  }));

  const parsed = JSON.parse(extractJsonObject(raw) ?? raw);
  const comparedAt = new Date();
  const outputPath = path.join(
    outputFolder,
    `${path.basename(resolvedOldPath, path.extname(resolvedOldPath))}__vs__${path.basename(resolvedNewPath, path.extname(resolvedNewPath))}__${safeFileToken(OLLAMA_MODEL)}__${timestampToken(comparedAt)}.json`
  );

  fs.writeFileSync(outputPath, JSON.stringify({
    comparedAt: comparedAt.toISOString(),
    model: OLLAMA_MODEL,
    oldFile: resolvedOldPath,
    newFile: resolvedNewPath,
    ...parsed,
  }, null, 2), "utf-8");

  console.log(`✅ Comparação guardada em: ${outputPath}`);
  console.log(parsed.summary || "Sem resumo disponível.");
  if (Array.isArray(parsed.changes) && parsed.changes.length) {
    parsed.changes.slice(0, 5).forEach((change, index) => {
      console.log(`\n${index + 1}. [${change.type}] ${change.topic}`);
      console.log(change.impact);
    });
  }
}

main().catch((error) => {
  const message = error?.name === "AbortError"
    ? `Timeout ao aguardar resposta do Ollama (${OLLAMA_TIMEOUT_MS}ms).`
    : error?.message ?? error;
  console.error("❌ Erro ao comparar documentos:", message);
  process.exitCode = 1;
});