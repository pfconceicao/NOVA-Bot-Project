// test-multiple-questions.js
import fetch from "node-fetch";

const QUESTIONS = [
  "arranja-me uma casa",
  "arranja-me uma casa na Universidade",
  ];

async function askQuestion(question) {
  try {
    const response = await fetch("http://localhost:3000/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question })
    });

    const data = await response.json().catch(() => ({}));

    console.log(`\n📩 Pergunta: ${question}`);
    console.log(`🧾 HTTP: ${response.status}`);
    console.log(`💬 Resposta: ${data.answer ?? JSON.stringify(data)}`);
  } catch (err) {
    console.error("\nErro ao enviar pergunta:", question);
    console.error(err);
  }
}

async function runTests() {
  for (const q of QUESTIONS) {
    await askQuestion(q);
  }
}

runTests();
