import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { pipeline } from "@xenova/transformers";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

// carregar vectorstore
const vectorPath = path.join(__dirname, "vectorstore.json");
if (!fs.existsSync(vectorPath)) {
  console.error("❌ vectorstore.json não encontrado. Corre primeiro o indexdocs.js");
  process.exit(1);
}
const vectorStore = JSON.parse(fs.readFileSync(vectorPath, "utf-8"));

// embeddings
const embedder = await pipeline(
  "feature-extraction",
  path.join(__dirname, "models/all-MiniLM-L6-v2") // usar modelo local
);

// similaridade cosseno
function cosineSimilarity(a, b) {
  const dot = a.reduce((sum, v, i) => sum + v * b[i], 0);
  const normA = Math.sqrt(a.reduce((sum, v) => sum + v * v, 0));
  const normB = Math.sqrt(b.reduce((sum, v) => sum + v * v, 0));
  return dot / (normA * normB);
}

app.post("/api/chat", async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: "Mensagem vazia" });

  try {
    const queryEmbedding = (await embedder(message))[0][0];

    const ranked = vectorStore
      .map(d => ({
        text: d.text,
        score: cosineSimilarity(queryEmbedding, d.embedding)
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);

    const context = ranked.map(r => r.text).join("\n");

    const prompt = `
Responde apenas com base no contexto abaixo.
Se a resposta não estiver no contexto, diz que não tens informação suficiente.

Contexto:
${context}

Pergunta:
${message}
`;

    const response = await fetch("http://localhost:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "mistral",
        prompt,
        stream: false
      })
    });

    const data = await response.json();
    res.json({ reply: data.response });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro interno" });
  }
});

app.listen(3001, () =>
  console.log("✅ NOVA.Bot a correr em http://localhost:3001")
);
