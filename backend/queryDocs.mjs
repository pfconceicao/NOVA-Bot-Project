import fs from "fs";
import path from "path";
import { pipeline } from "@xenova/transformers";

// ───────── CONFIGURAÇÃO ─────────
const indexFolder = path.resolve("./index_docs");
const modelPath = "Xenova/all-MiniLM-L6-v2";
const TOP_K = 3; // número de chunks mais relevantes

// ───────── FUNÇÃO DE SIMILARIDADE COSENO ─────────
function cosineSimilarity(vecA, vecB) {
  let dot = 0.0;
  let normA = 0.0;
  let normB = 0.0;

  for (let i = 0; i < vecA.length; i++) {
    dot += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ───────── MAIN ─────────
async function main() {
  console.log("🧠 A carregar modelo de embeddings...");
  const embedder = await pipeline(
    "feature-extraction",
    modelPath,
    { pooling: "mean", normalize: true }
  );
  console.log("✅ Modelo carregado");

  // Carregar todos os JSONs
  const jsonFiles = fs.readdirSync(indexFolder).filter(f => f.endsWith(".json"));
  const chunks = [];

  for (const file of jsonFiles) {
    const data = JSON.parse(fs.readFileSync(path.join(indexFolder, file), "utf-8"));
    chunks.push(...data.map(c => ({ ...c, file })));
  }
  console.log(`📚 Total de chunks carregados: ${chunks.length}`);

  // Pergunta do utilizador
  const question = "Quais são os objetivos da Universidade NOVA de Lisboa?";
  const qEmbeddingTensor = await embedder(question);
  const qEmbedding = Array.from(qEmbeddingTensor.data);

  // Calcular similaridade
  const scored = chunks.map(c => ({
    ...c,
    score: cosineSimilarity(qEmbedding, c.embedding)
  }));

  // Ordenar e pegar os TOP_K
  scored.sort((a, b) => b.score - a.score);
  const topChunks = scored.slice(0, TOP_K);

  console.log(`\n📝 Pergunta: "${question}"`);
  console.log(`\n🔹 Top ${TOP_K} chunks mais relevantes:`);

  topChunks.forEach((c, i) => {
    console.log(`\n[${i + 1}] ${c.file} - chunk ${c.chunkIndex} (score: ${c.score.toFixed(4)})`);
    console.log(c.text.slice(0, 300) + "…"); // mostra apenas os primeiros 300 caracteres
  });
}

main().catch(console.error);
