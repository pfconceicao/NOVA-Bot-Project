// testChunks.mjs
import fs from "fs";
import path from "path";
import * as pdfParse from "pdf-parse"; // versão 2.x ESM
import { pipeline } from "@xenova/transformers";

// Pasta onde estão os PDFs
const pdfFolder = "C:/ollama/backend/docs";

// Path para o modelo local
const modelPath = "file:///C:/ollama/backend/models/all-MiniLM-L6_v2";

// Função para extrair texto de um PDF
async function extractTextFromPDF(filePath) {
  try {
    const dataBuffer = await fs.promises.readFile(filePath);
    const data = await pdfParse.default(dataBuffer); // obrigatório no 2.x
    return data.text;
  } catch (err) {
    console.error(`Erro ao processar ${path.basename(filePath)}:`, err);
    return "";
  }
}

// Função para dividir texto em chunks
function chunkText(text, chunkSize = 500) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    chunks.push(text.slice(start, start + chunkSize));
    start += chunkSize;
  }
  return chunks;
}

// Função principal
async function main() {
  // Lista PDFs na pasta
  const pdfFiles = fs.readdirSync(pdfFolder).filter(f => f.endsWith(".pdf"));
  console.log("PDFs encontrados:", pdfFiles);

  // Inicializar pipeline local
  console.log("🧠 A carregar modelo de embeddings (LOCAL)...");
  let embedder;
  try {
    embedder = await pipeline("feature-extraction", modelPath);
  } catch (err) {
    console.error("❌ Erro ao carregar o modelo local:", err);
    return;
  }

  for (const fileName of pdfFiles) {
    const filePath = path.join(pdfFolder, fileName);
    console.log(`➡️ A processar ${fileName}`);

    const text = await extractTextFromPDF(filePath);
    if (!text) continue;

    const chunks = chunkText(text);
    console.log(`   🔹 Dividido em ${chunks.length} chunks`);

    for (const [i, chunk] of chunks.entries()) {
      try {
        const embedding = await embedder(chunk);
        console.log(`     ✅ Chunk ${i + 1} embedding gerado, tamanho:`, embedding.length);
      } catch (err) {
        console.error(`     ❌ Erro ao gerar embedding para chunk ${i + 1}:`, err);
      }
    }
  }
}

main().catch(err => console.error(err));
