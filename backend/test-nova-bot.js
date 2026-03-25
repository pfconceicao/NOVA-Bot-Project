import fetch from "node-fetch";

async function testNovaBot() {
  const question = "o que é o jantar?";

  try {
    const res = await fetch("http://localhost:3000/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question })
    });

    const data = await res.json();
    console.log("💬 Resposta do NOVA.Bot:\n");
    console.log(data.answer);
  } catch (err) {
    console.error("❌ Erro ao chamar o NOVA.Bot:", err);
  }
}

testNovaBot();
