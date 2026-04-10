import fs from "fs";
import path from "path";

const reviewFolder = path.resolve("./data/generated-faqs/review");
const approvedFolder = path.resolve("./data/generated-faqs/approved");

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function listReviewFiles() {
  if (!fs.existsSync(reviewFolder)) return [];
  return fs.readdirSync(reviewFolder).filter((fileName) => fileName.toLowerCase().endsWith(".json"));
}

function resolveInputFile(inputArg) {
  const reviewFiles = listReviewFiles();
  if (!inputArg) return null;

  const exactMatch = reviewFiles.find((fileName) => fileName.toLowerCase() === inputArg.toLowerCase());
  if (exactMatch) return exactMatch;

  return reviewFiles.find((fileName) => fileName.toLowerCase().includes(inputArg.toLowerCase())) || null;
}

async function main() {
  ensureDir(approvedFolder);

  const inputArg = process.argv[2] || "";
  const selectedFile = resolveInputFile(inputArg);

  if (!selectedFile) {
    console.log("Uso: npm run faqs:approve -- <ficheiro-ou-fragmento>");
    const reviewFiles = listReviewFiles();
    if (reviewFiles.length) {
      console.log("FAQs em revisão disponíveis:");
      reviewFiles.forEach((fileName) => console.log(`- ${fileName}`));
    }
    process.exitCode = 1;
    return;
  }

  const sourcePath = path.join(reviewFolder, selectedFile);
  const outputPath = path.join(approvedFolder, selectedFile);
  const payload = JSON.parse(fs.readFileSync(sourcePath, "utf-8"));

  payload.status = "approved";
  payload.approvedAt = new Date().toISOString();

  fs.writeFileSync(outputPath, JSON.stringify(payload, null, 2), "utf-8");
  console.log(`✅ FAQs aprovadas guardadas em: ${outputPath}`);
}

main().catch((error) => {
  console.error("❌ Erro ao aprovar FAQs:", error?.message ?? error);
  process.exitCode = 1;
});