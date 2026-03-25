import fs from "fs";
import path from "path";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";

const pdfFolder = path.resolve("./docs");

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

// 🔹 chunking determinístico
function chunkText(text, chunkSize = 1000, overlap = 200) {
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

async function main() {
  const pdfFiles = fs.readdirSync(pdfFolder).filter(f => f.endsWith(".pdf"));

  for (const file of pdfFiles) {
    console.log(`\n📄 ${file}`);
    const filePath = path.join(pdfFolder, file);

    const text = await extractTextFromPDF(filePath);
    const chunks = chunkText(text);

    console.log(`   🔢 Texto total: ${text.length} caracteres`);
    console.log(`   🧩 Nº de chunks: ${chunks.length}`);

    console.log("\n🔎 Exemplo de chunk:");
    console.log(chunks[0].slice(0, 500));
  }
}

main();
