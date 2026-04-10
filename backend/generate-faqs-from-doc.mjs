import fs from "fs";
import path from "path";

const indexFolder = path.resolve("./index_docs");
const outputFolder = path.resolve("./data/generated-faqs/review");
const OLLAMA_HOST = process.env.OLLAMA_HOST || "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_SUPPORT_MODEL || process.env.OLLAMA_MODEL || "mistral";
const MAX_CONTEXT_CHARS = 1200;
const MAX_CONTEXT_CHUNKS = 1;
const MAX_BATCHES = 3;
const DEFAULT_FAQ_COUNT = 10;
const OLLAMA_TIMEOUT_MS = Number.parseInt(
  process.env.OLLAMA_SUPPORT_TIMEOUT_MS || process.env.OLLAMA_TIMEOUT_MS || "120000",
  10
);

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function listIndexedDocs() {
  if (!fs.existsSync(indexFolder)) return [];

  return fs.readdirSync(indexFolder)
    .filter((fileName) => fileName.toLowerCase().endsWith(".ndjson"))
    .sort((left, right) => left.localeCompare(right, "pt"));
}

function readNdjson(filePath) {
  const raw = fs.readFileSync(filePath, "utf-8");
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function buildContext(chunks, maxChars = MAX_CONTEXT_CHARS) {
  let total = 0;
  const parts = [];

  for (const chunk of chunks) {
    if (parts.length >= MAX_CONTEXT_CHUNKS) break;

    const text = String(chunk?.text ?? "").trim();
    if (!text) continue;

    const part = `[[PAGE:${chunk?.pageNumber ?? "?"}]] ${text}`;
    if (total + part.length > maxChars) break;

    parts.push(part);
    total += part.length + 2;
  }

  return parts.join("\n\n");
}

function buildChunkBatches(chunks) {
  const batches = [];
  let currentBatch = [];
  let currentChars = 0;

  for (const chunk of chunks) {
    const text = String(chunk?.text ?? "").trim();
    if (!text) continue;

    const chunkText = `[[PAGE:${chunk?.pageNumber ?? "?"}]] ${text}`;
    const wouldOverflow =
      currentBatch.length >= MAX_CONTEXT_CHUNKS ||
      currentChars + chunkText.length > MAX_CONTEXT_CHARS;

    if (wouldOverflow && currentBatch.length) {
      batches.push(currentBatch);
      if (batches.length >= MAX_BATCHES) break;
      currentBatch = [];
      currentChars = 0;
    }

    if (batches.length >= MAX_BATCHES) break;

    currentBatch.push(chunk);
    currentChars += chunkText.length;
  }

  if (currentBatch.length && batches.length < MAX_BATCHES) {
    batches.push(currentBatch);
  }

  return batches;
}

function safeBaseName(fileName) {
  return fileName.replace(/\.ndjson$/i, "");
}

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
        temperature: 0.2,
        num_predict: 220,
        num_ctx: 1024,
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

async function callOllamaForJsonRepair(rawContent, faqCount) {
  const prompt = `
Recebeste uma saída JSON malformada de um modelo.

Tarefa:
- Reescreve o conteúdo como JSON válido.
- Mantém APENAS os pares pergunta-resposta que já existam.
- Se existir sourcePages, mantém-na como array de inteiros.
- Se houver apenas 1 FAQ, podes devolver um array com 1 objeto.
- Não inventes conteúdo novo.
- Devolve APENAS JSON válido: array de objetos com as chaves "question", "answer" e "sourcePages".
- Limita o resultado a ${faqCount} FAQ(s).

Conteúdo a reparar:
${rawContent}
`.trim();

  return callOllama(prompt);
}

function extractJsonBlock(raw) {
  const text = String(raw ?? "");
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}

function sanitizeJsonLike(text) {
  return String(text ?? "")
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```$/i, "")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/,\s*([}\]])/g, "$1")
    .trim();
}

function tryParseFaqPayload(raw) {
  const candidates = [];
  const jsonBlock = extractJsonBlock(raw);

  if (jsonBlock) candidates.push(jsonBlock);
  candidates.push(raw);

  for (const candidate of candidates) {
    const sanitized = sanitizeJsonLike(candidate);
    if (!sanitized) continue;

    try {
      const parsed = JSON.parse(sanitized);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      // continue
    }
  }

  return null;
}

async function parseFaqPayload(raw, faqCount) {
  const parsed = tryParseFaqPayload(raw);
  if (parsed) return parsed;

  const repairedRaw = await callOllamaForJsonRepair(raw, faqCount);
  const repairedParsed = tryParseFaqPayload(repairedRaw);
  if (repairedParsed) return repairedParsed;

  throw new Error("O modelo devolveu JSON inválido e a reparação automática falhou.");
}

function normalizeFaqs(items) {
  if (!Array.isArray(items)) return [];

  return items
    .map((item) => ({
      question: String(item?.question ?? "").trim(),
      answer: String(item?.answer ?? "").trim(),
      sourcePages: Array.isArray(item?.sourcePages)
        ? [...new Set(item.sourcePages.map((value) => Number.parseInt(value, 10)).filter(Number.isFinite))]
        : [],
    }))
    .filter((item) => item.question && item.answer);
}

function dedupeFaqs(items, limit = DEFAULT_FAQ_COUNT) {
  const seen = new Set();
  const out = [];

  for (const item of items) {
    const key = String(item?.question ?? "").toLowerCase().trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= limit) break;
  }

  return out;
}

function buildPrompt({ documentName, context, faqCount }) {
  return `
És um assistente de apoio à equipa que mantém um chatbot académico universitário.

Com base EXCLUSIVAMENTE no conteúdo abaixo, gera ${faqCount} pares de pergunta-resposta úteis para estudantes.

Regras:
- Responde em português de Portugal.
- Gera perguntas práticas, claras e realistas.
- Privilegia perguntas sobre procedimentos, requisitos, prazos, contactos, elegibilidade, custos e passos operacionais, quando aplicável.
- Não inventes informação que não esteja no conteúdo.
- Se o documento não suportar um tema, não o incluas.
- Quando possível, referencia as páginas usadas através da chave "sourcePages", com números inteiros extraídos dos marcadores [[PAGE:X]].
- Devolve APENAS JSON válido: um array de objetos com as chaves "question", "answer" e "sourcePages".
- Não incluas markdown, explicações nem texto fora do JSON.
- Mantém cada resposta em 1 ou 2 frases curtas.

Documento: ${documentName}

Conteúdo:
${context}
`.trim();
}

async function main() {
  ensureDir(outputFolder);

  const indexedDocs = listIndexedDocs();
  if (!indexedDocs.length) {
    console.log("⚠️ Não existem ficheiros indexados em ./index_docs.");
    return;
  }

  const targetArg = process.argv[2] || "";
  const faqCountArg = Number.parseInt(process.argv[3] || "", 10);
  const faqCount = Number.isFinite(faqCountArg) && faqCountArg > 0 ? faqCountArg : DEFAULT_FAQ_COUNT;

  const selectedDoc = targetArg
    ? indexedDocs.find((fileName) => safeBaseName(fileName).toLowerCase().includes(targetArg.toLowerCase()))
    : indexedDocs[0];

  if (!selectedDoc) {
    console.log("❌ Documento não encontrado. Documentos indexados disponíveis:");
    indexedDocs.forEach((fileName) => console.log(`- ${fileName}`));
    process.exitCode = 1;
    return;
  }

  const filePath = path.join(indexFolder, selectedDoc);
  const chunks = readNdjson(filePath);
  const batches = buildChunkBatches(chunks);

  if (!batches.length) {
    console.log(`⚠️ O documento ${selectedDoc} não tem texto utilizável.`);
    return;
  }

  console.log(`📄 Documento selecionado: ${selectedDoc}`);
  console.log(`🧠 A gerar ${faqCount} FAQs candidatas com o modelo ${OLLAMA_MODEL} em ${batches.length} bloco(s)...`);

  const faqsCollected = [];
  let remainingFaqs = faqCount;

  for (const [index, batch] of batches.entries()) {
    if (remainingFaqs <= 0) break;

    const batchContext = buildContext(batch);
    const batchFaqCount = Math.max(1, Math.ceil(remainingFaqs / (batches.length - index)));
    console.log(`   • Bloco ${index + 1}/${batches.length}: a pedir ${batchFaqCount} FAQ(s)`);

    const raw = await callOllama(buildPrompt({
      documentName: selectedDoc,
      context: batchContext,
      faqCount: batchFaqCount,
    }));

    const parsed = await parseFaqPayload(raw, batchFaqCount);
    const normalizedFaqs = normalizeFaqs(parsed).map((faq) => ({
      ...faq,
      sourcePages: faq.sourcePages.length
        ? faq.sourcePages
        : [...new Set(batch.map((chunk) => chunk?.pageNumber).filter(Boolean))],
      sourceChunkIndexes: batch.map((chunk) => chunk?.chunkIndex).filter(Number.isFinite),
    }));

    faqsCollected.push(...normalizedFaqs);
    remainingFaqs = faqCount - dedupeFaqs(faqsCollected, faqCount).length;
  }

  const faqs = dedupeFaqs(faqsCollected, faqCount);

  if (!faqs.length) {
    throw new Error("O modelo não devolveu FAQs válidas.");
  }

  const generatedAt = new Date();
  const outputPath = path.join(
    outputFolder,
    `${safeBaseName(selectedDoc)}__${safeFileToken(OLLAMA_MODEL)}__${timestampToken(generatedAt)}.json`
  );
  const payload = {
    status: "pending_review",
    source: selectedDoc,
    model: OLLAMA_MODEL,
    generatedAt: generatedAt.toISOString(),
    sourceType: "indexed-document",
    generationConfig: {
      faqCount,
      maxContextChars: MAX_CONTEXT_CHARS,
      maxContextChunks: MAX_CONTEXT_CHUNKS,
      maxBatches: MAX_BATCHES,
      timeoutMs: OLLAMA_TIMEOUT_MS,
    },
    faqs,
  };

  fs.writeFileSync(outputPath, JSON.stringify(payload, null, 2), "utf-8");

  console.log(`✅ FAQs candidatas guardadas em revisão: ${outputPath}`);
  console.log("\nPré-visualização:");
  faqs.slice(0, 3).forEach((faq, index) => {
    console.log(`\n${index + 1}. ${faq.question}`);
    console.log(faq.answer);
    if (faq.sourcePages.length) {
      console.log(`Páginas: ${faq.sourcePages.join(", ")}`);
    }
  });
}

main().catch((error) => {
  const message = error?.name === "AbortError"
    ? `Timeout ao aguardar resposta do Ollama (${OLLAMA_TIMEOUT_MS}ms).`
    : error?.message ?? error;
  console.error("❌ Erro ao gerar FAQs candidatas:", message);
  process.exitCode = 1;
});
