import { pipeline } from "@xenova/transformers";

async function main() {
  console.log("🧠 A carregar modelo de embeddings (remoto/HF)...");
  
  // Modelo remoto (vai baixar e guardar em cache local)
  const embedder = await pipeline(
    "feature-extraction",
    "Xenova/all-MiniLM-L6-v2",
    {
      pooling: "mean",
      normalize: true
    }
  );

  console.log("✅ Modelo carregado");

  const text = "A Universidade NOVA de Lisboa é uma fundação pública.";

  const embedding = await embedder(text);

  console.log("🔢 Tipo:", typeof embedding);
  console.log("📐 Dimensão:", embedding.length);
  console.log("🔎 Primeiros valores:", embedding.slice(0, 5));
}

main().catch(console.error);
