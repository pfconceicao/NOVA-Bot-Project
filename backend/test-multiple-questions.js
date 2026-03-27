// test-multiple-questions.js
import fetch from "node-fetch";
import readline from "readline";

const cliQuestions = process.argv.slice(2).map((value) => value.trim()).filter(Boolean);
const QUESTIONS = cliQuestions;

const SESSION_ID = `test-${Date.now()}`;
const API_URL = "http://localhost:3000/ask";

async function askQuestion(question) {
  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, sessionId: SESSION_ID })
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

async function runInteractiveMode() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log("\n========================================");
  console.log("NOVA.Bot - modo de teste interativo");
  console.log("========================================");
  console.log(`Sessao atual: ${SESSION_ID}`);
  console.log(`API: ${API_URL}`);
  console.log("Pronto para receber perguntas.");
  console.log("Comandos: 'nova' cria uma nova sessao | 'sair' termina o teste.");
  console.log("Exemplo: quem e o reitor?");

  let currentSessionId = SESSION_ID;

  const askPrompt = () => {
    rl.question("\nPergunta> ", async (input) => {
      const question = input.trim();

      if (!question) {
        askPrompt();
        return;
      }

      if (question.toLowerCase() === "sair") {
        rl.close();
        return;
      }

      if (question.toLowerCase() === "nova") {
        currentSessionId = `test-${Date.now()}`;
        console.log(`Nova sessao: ${currentSessionId}`);
        askPrompt();
        return;
      }

      try {
        const response = await fetch(API_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question, sessionId: currentSessionId })
        });

        const data = await response.json().catch(() => ({}));

        console.log(`\n📩 Pergunta: ${question}`);
        console.log(`🧾 HTTP: ${response.status}`);
        console.log(`💬 Resposta: ${data.answer ?? JSON.stringify(data)}`);
      } catch (err) {
        console.error("\nErro ao enviar pergunta:", question);
        console.error(err);
      }

      askPrompt();
    });
  };

  askPrompt();
}

async function runTests() {
  if (QUESTIONS.length === 0) {
    await runInteractiveMode();
    return;
  }

  console.log(`Sessao de teste: ${SESSION_ID}`);

  for (const q of QUESTIONS) {
    await askQuestion(q);
  }
}

runTests();
