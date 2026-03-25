// --- Seletores principais ---
const botButton = document.getElementById("nova-bot-button");
const botWindow = document.getElementById("nova-bot-chatbox");
const messages = document.getElementById("nova-bot-messages");
const input = document.getElementById("user-input");
const languageSelect = document.getElementById("language-select");
const resetBtn = document.getElementById("reset-chat");
const sendBtn = document.getElementById("send-btn");

let currentLanguage = languageSelect.value;

// --- FAQ simplificada como fallback ---
const faqs = {
  pt: [
    { label: "Contactos Principais", keywords: ["contacto", "telefone", "email"], answer: "<p>Para informações gerais da NOVA: geral@unl.pt | +351 21 371 5600</p>" },
    { label: "Candidaturas", keywords: ["candidatura", "inscrição"], answer: "<p>As candidaturas ao ensino superior público são feitas através do concurso nacional DGES. Mais info: <a href='https://www.dges.gov.pt/' target='_blank'>DGES</a></p>" }
  ],
  en: [
    { label: "Main Contacts", keywords: ["contact", "phone", "email"], answer: "<p>For general information at NOVA: geral@unl.pt | +351 21 371 5600</p>" },
    { label: "Applications", keywords: ["application", "admission"], answer: "<p>Applications to public higher education are made through the national competition DGES. More info: <a href='https://www.dges.gov.pt/' target='_blank'>DGES</a></p>" }
  ]
};

// --- Mensagens padrão ---
const translations = {
  welcome: { pt: "Olá! Pergunta-me qualquer coisa ou escreve 'tópicos' para explorar a FAQ.", en: "Hello! Ask me anything or type 'topics' to explore the FAQ." },
  notFound: { pt: "Não encontrei informação. Tenta reformular ou escreve 'tópicos'.", en: "I couldn't find info. Try rephrasing or type 'topics'." }
};

// --- Normalização ---
function normalizeText(text) {
  return text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\w\s]/g, "").trim();
}

// --- Histórico ---
const botHistory = [];

// --- Indicador "a escrever..." ---
function showTypingIndicator() {
  const wrap = document.createElement("div");
  wrap.className = "chat-message";
  const strong = document.createElement("strong");
  strong.textContent = "NUMA: ";
  const span = document.createElement("span");
  span.className = "typing-dots";
  wrap.appendChild(strong);
  wrap.appendChild(span);
  messages.appendChild(wrap);
  messages.scrollTop = messages.scrollHeight;

  let dots = 0;
  const interval = setInterval(() => {
    dots = (dots + 1) % 4;
    span.textContent = ".".repeat(dots);
  }, 320);

  return { el: wrap, timer: interval };
}

function removeTypingIndicator(ind) {
  if (!ind) return;
  clearInterval(ind.timer);
  if (ind.el && ind.el.parentNode) ind.el.remove();
}

// --- Append mensagem bot ---
function appendBotMessage(text) {
  const msg = document.createElement("div");
  msg.className = "chat-message";
  const strong = document.createElement("strong");
  strong.textContent = "NUMA: ";
  msg.appendChild(strong);
  const span = document.createElement("span");
  span.innerHTML = text;
  msg.appendChild(span);
  messages.appendChild(msg);
  messages.scrollTop = messages.scrollHeight;
  botHistory.push({ type: 'bot', text });
}

// --- Append mensagem utilizador ---
function appendUserMessage(text) {
  const msg = document.createElement("div");
  msg.className = "chat-message";
  const strong = document.createElement("strong");
  strong.textContent = "Tu: ";
  msg.appendChild(strong);
  const span = document.createElement("span");
  span.textContent = text;
  msg.appendChild(span);
  messages.appendChild(msg);
  messages.scrollTop = messages.scrollHeight;
}

// --- Reset chat ---
resetBtn.addEventListener("click", () => {
  messages.innerHTML = "";
  botHistory.length = 0;
  appendBotMessage(translations.welcome[currentLanguage]);
});

// --- Processar pergunta ---
function handleUserMessage(text) {
  appendUserMessage(text);
  const normalized = normalizeText(text);

  if (["topicos", "topics"].includes(normalized.replace(/\s+/g, ""))) {
    showAllTopics();
    return;
  }

  const faqList = faqs[currentLanguage] || [];
  let matched = faqList.find(item => item.keywords.some(k => normalized.includes(normalizeText(k))));

  const ind = showTypingIndicator();
  setTimeout(() => {
    removeTypingIndicator(ind);
    if (matched) appendBotMessage(matched.answer);
    else appendBotMessage(translations.notFound[currentLanguage]);
  }, 600);
}

// --- Mostrar tópicos interativos ---
function showAllTopics() {
  const faqList = faqs[currentLanguage] || [];
  let html = "<ul>";
  faqList.forEach((item, index) => {
    html += `<li><button class="btn-option" data-index="${index}">${item.label}</button></li>`;
  });
  html += "</ul>";
  appendBotMessage(html);

  faqList.forEach((_, idx) => {
    const btn = messages.querySelector(`.btn-option[data-index="${idx}"]`);
    if (btn) btn.addEventListener("click", () => {
      handleUserMessage(faqList[idx].keywords[0]);
    });
  });
}

// --- Eventos ---
sendBtn.addEventListener("click", () => {
  const text = input.value.trim();
  if (text) {
    handleUserMessage(text);
    input.value = "";
  }
});

input.addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    if (input.value.trim()) {
      handleUserMessage(input.value.trim());
      input.value = "";
    }
  }
});

// --- Bot flutuante ---
botButton.addEventListener("click", () => {
  const showing = botWindow.style.display === "flex";
  botWindow.style.display = showing ? "none" : "flex";
  botButton.classList.toggle("active", !showing);

  if (!showing && messages.innerHTML === "") {
    appendBotMessage(translations.welcome[currentLanguage]);
  }
});

// --- Alterar idioma ---
languageSelect.addEventListener("change", e => {
  currentLanguage = e.target.value;
  // Atualizar mensagem de boas-vindas se chat estiver vazio
  if (messages.innerHTML === "") {
    appendBotMessage(translations.welcome[currentLanguage]);
  }
});

// --- Inicializar boas-vindas no carregamento ---
window.addEventListener("load", () => {
  if (messages.innerHTML === "") {
    appendBotMessage(translations.welcome[currentLanguage]);
  }
});
