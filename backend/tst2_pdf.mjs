import fs from "fs";
import path from "path";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";

const pdfFolder = path.resolve("./docs");

async function extractTextFromPDF(filePath) {
  const data = new Uint8Array(await fs.promises.readFile(filePath));

  const pdf = await pdfjsLib.getDocument({ data }).promise;

  let fullText = "";

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();

    const strings = content.items.map(item => item.str);
    fullText += strings.join(" ") + "\n";
  }

  return fullText;
}

async function main() {
  const pdfFiles = fs.readdirSync(pdfFolder).filter(f => f.endsWith(".pdf"));

  console.log("PDFs encontrados:", pdfFiles);

  for (const file of pdfFiles) {
    console.log(`\n📄 A processar: ${file}`);
    const filePath = path.join(pdfFolder, file);

    try {
      const text = await extractTextFromPDF(filePath);
      console.log("✅ Texto extraído com sucesso");
      console.log("🔢 Nº de caracteres:", text.length);
      console.log("🔎 Primeiros 500 caracteres:\n");
      console.log(text.slice(0, 500));
    } catch (err) {
      console.error("❌ Erro ao processar PDF:", err);
    }
  }
}

main();
