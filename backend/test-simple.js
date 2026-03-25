import fetch from "node-fetch";

async function test() {
  try {
    console.log("Enviando pergunta...");
    const response = await fetch("http://localhost:3000/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "o que é o reconhecimento automático?" })
    });

    console.log("Status:", response.status);
    const data = await response.json();
    console.log("Resposta:", JSON.stringify(data, null, 2));
  } catch (err) {
    console.error("Erro:", err.message);
  }
}

test();
