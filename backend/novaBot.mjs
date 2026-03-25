console.log("🟢 NOVA.Bot script iniciado...");

import fs from "fs";
import path from "path";
import { pipeline } from "@xenova/transformers";

// ───────── CONFIGURAÇÃO ─────────
const indexFolder = path.resolve("./index_docs");
const modelPath = "Xenova/all-MiniLM-L6-v2"; // embeddings
const TOP_K = 3; // número de chunks usados como contexto

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

// ───────── FUNÇÃO PARA CARREGAR TODOS OS CHUNKS ─────────
function loadAllChunks() {
  const jsonFiles = fs.readdirSync(indexFolder).filter(f => f.endsWith(".json"));
  const chunks = [];

  for (const file of jsonFiles) {
    const data = JSON.parse(fs.readFileSync(path.join(indexFolder, file), "utf-8"));
    chunks.push(...data.map(c => ({ ...c, file })));
  }
  return chunks;
}

// ───────── FUNÇÃO PRINCIPAL PARA USAR NO BACKEND ─────────
let embedderInstance = null;
let chunksCache = null;

export async function initBot() {
  if (!embedderInstance) {
    console.log("🧠 A carregar modelo de embeddings...");
    embedderInstance = await pipeline(
      "feature-extraction",
      modelPath,
      { pooling: "mean", normalize: true }
    );
    console.log("✅ Modelo de embeddings carregado");
  }

  if (!chunksCache) {
    chunksCache = loadAllChunks();
    console.log(`📚 Total de chunks carregados: ${chunksCache.length}`);
  }

  return true;
}

export async function ask(question) {
  if (!embedderInstance || !chunksCache) {
    throw new Error("Bot não inicializado. Executa initBot() primeiro.");
  }

  if (!question || question.trim() === "") return "Pergunta vazia.";

  const qEmbeddingTensor = await embedderInstance(question);
  const qEmbedding = Array.from(qEmbeddingTensor.data);

  // Calcular similaridade com todos os chunks
  const scored = chunksCache.map(c => ({
    ...c,
    score: cosineSimilarity(qEmbedding, c.embedding)
  }));

  scored.sort((a, b) => b.score - a.score);
  const topChunks = scored.slice(0, TOP_K);

  // Montar contexto
  const contextText = topChunks.map(c => c.text).join("\n---\n");

  // Para debug, podes deixar os logs
  console.log("\n🔹 Contexto selecionado:");
  topChunks.forEach((c, i) => {
    console.log(` [${i + 1}] ${c.file} - chunk ${c.chunkIndex} (score: ${c.score.toFixed(4)})`);
    console.log(c.text.slice(0, 200) + "...\n");
  });

  return {
    context: contextText,
    topChunks: topChunks.map(c => ({ file: c.file, chunkIndex: c.chunkIndex, score: c.score })),
    // Aqui irias integrar GPT/OpenAI para gerar a resposta real
    response: "🤖 Aqui é onde a resposta do GPT seria exibida."
  };
}
