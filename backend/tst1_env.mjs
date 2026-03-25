import fs from "fs";
import path from "path";

console.log("✅ Node.js ESM a funcionar");

console.log("Node version:", process.version);
console.log("CWD:", process.cwd());

const docsPath = path.resolve("./docs");
console.log("Pasta docs existe?", fs.existsSync(docsPath));
