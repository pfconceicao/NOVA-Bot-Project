const botButton = document.getElementById("nova-bot-button");
const botWindow = document.getElementById("nova-bot-chatbox");
const messages = document.getElementById("nova-bot-messages");
const input = document.getElementById("user-input");
const languageSelect = document.getElementById("language-select");
const resetBtn = document.getElementById("reset-chat");
const sendBtn = document.getElementById("send-btn");
const optionsToggle = document.getElementById("options-toggle");
const accessibilityMenu = document.getElementById("accessibility-menu");
const increaseFontBtn = document.getElementById("increase-font");
const decreaseFontBtn = document.getElementById("decrease-font");
const toggleThemeBtn = document.getElementById("toggle-theme");

const API_URL = "http://localhost:3000/ask";
const FONT_SCALE_MIN = 0.9;
const FONT_SCALE_MAX = 1.2;
const FONT_SCALE_STEP = 0.05;
const TYPEWRITER_MIN_DELAY_MS = 8;
const TYPEWRITER_MAX_DELAY_MS = 20;
const REQUEST_TIMEOUT_MS = 90000;

const state = {
  currentLanguage: languageSelect.value,
  currentSessionId: createSessionId(),
  fontScale: 1,
  isAccessibleTheme: false,
  isWaitingResponse: false,
};

const translations = {
  welcome: {
    pt: "Olá. Estou aqui para ajudar. Faça a sua pergunta quando quiser.",
    en: "Hello. I am here to help. Ask your question whenever you are ready.",
  },
  hint: {
    pt: "Pode fazer follow-ups na mesma conversa ou iniciar um novo chat para limpar o contexto.",
    en: "You can ask follow-up questions in the same chat or start a new chat to clear context.",
  },
  placeholder: {
    pt: "Escreve aqui…",
    en: "Type here…",
  },
  error: {
    pt: "Não foi possível obter resposta neste momento.",
    en: "It was not possible to get a response right now.",
  },
  offline: {
    pt: "Não consegui contactar o servidor. Verifique se o backend está ativo em http://localhost:3000.",
    en: "I could not reach the server. Check whether the backend is running at http://localhost:3000.",
  },
  timeout: {
    pt: "Não consegui responder a essa pergunta neste momento. Tente reformular ou escolha um dos tópicos sugeridos.",
    en: "I could not answer that question right now. Try rephrasing it or choose one of the suggested topics.",
  },
  empty: {
    pt: "Escreve uma pergunta para continuar.",
    en: "Type a question to continue.",
  },
  reset: {
    pt: "Novo chat iniciado. O contexto anterior foi limpo.",
    en: "New chat started. Previous context was cleared.",
  },
  suggestionsTitle: {
    pt: "Sugestões",
    en: "Suggestions",
  },
  blocked: {
    pt: "Essa pergunta parece fora do âmbito do bot. Tente reformular no contexto da NOVA ou do reconhecimento académico.",
    en: "That question seems outside the bot's scope. Try rephrasing it in the NOVA or academic recognition context.",
  },
};

const quickPrompts = {
  pt: [
    "O que é o reconhecimento automático?",
    "Que documentos entregar para reconhecimento de nível?",
    "Quanto custa o reconhecimento específico?",
    "Qual é o horário da UAA?",
  ],
  en: [
    "What is automatic recognition?",
    "Which documents are required for level recognition?",
    "How much does specific recognition cost?",
    "What are the UAA opening hours?",
  ],
};

function createSessionId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `nova-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function linkifyText(text) {
  return text.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noreferrer noopener">$1</a>');
}

function formatAnswer(answer) {
  const lines = String(answer ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return `<p>${escapeHtml(String(answer ?? ""))}</p>`;
  }

  const parts = [];
  let bulletBuffer = [];

  const flushBullets = () => {
    if (bulletBuffer.length === 0) return;
    const items = bulletBuffer
      .map((item) => `<li>${linkifyText(escapeHtml(item))}</li>`)
      .join("");
    parts.push(`<ul class="message-list">${items}</ul>`);
    bulletBuffer = [];
  };

  lines.forEach((line) => {
    const bulletMatch = line.match(/^[•\-*]\s*(.+)$/);
    if (bulletMatch) {
      bulletBuffer.push(bulletMatch[1]);
      return;
    }

    flushBullets();
    parts.push(`<p>${linkifyText(escapeHtml(line))}</p>`);
  });

  flushBullets();
  return parts.join("");
}

function autoResizeInput() {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
}

function scrollMessagesToBottom() {
  messages.scrollTop = messages.scrollHeight;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getTypingDelay(textLength) {
  if (textLength > 280) return TYPEWRITER_MIN_DELAY_MS;
  if (textLength > 140) return 12;
  return TYPEWRITER_MAX_DELAY_MS;
}

function setLoadingState(isLoading) {
  state.isWaitingResponse = isLoading;
  sendBtn.disabled = isLoading;
  input.disabled = isLoading;
}

function createMessage({ role, html, meta, citations = [], actions = [] }) {
  const article = document.createElement("article");
  article.className = `chat-message ${role}`;

  const badge = document.createElement("div");
  badge.className = "message-role";
  badge.textContent = role === "user" ? "Tu" : role === "system" ? "Nota" : "NOVA.Bot";
  article.appendChild(badge);

  const bubble = document.createElement("div");
  bubble.className = "message-bubble";
  bubble.innerHTML = html;
  article.appendChild(bubble);

  messages.appendChild(article);
  scrollMessagesToBottom();

  return {
    article,
    bubble,
    appendMeta() {
      if (!meta) return;
      const metaEl = document.createElement("div");
      metaEl.className = "message-meta";
      metaEl.textContent = meta;
      article.appendChild(metaEl);
    },
    appendCitations() {
      if (citations.length === 0) return;
      const citationsWrap = document.createElement("div");
      citationsWrap.className = "message-citations";

      const title = document.createElement("div");
      title.className = "message-citations-title";
      title.textContent = state.currentLanguage === "pt" ? "Fontes" : "Sources";
      citationsWrap.appendChild(title);

      citations.slice(0, 3).forEach((citation) => {
        const item = document.createElement("div");
        item.className = "citation-item";

        const source = citation.source ? `<strong>${escapeHtml(citation.source)}</strong>` : "";
        const quote = citation.quote ? `<span>${escapeHtml(citation.quote)}</span>` : "";
        item.innerHTML = `${source}${source && quote ? "<br>" : ""}${quote}`;
        citationsWrap.appendChild(item);
      });

      article.appendChild(citationsWrap);
    },
    appendActions() {
      if (actions.length === 0) return;
      const actionsWrap = document.createElement("div");
      actionsWrap.className = "message-actions";

      actions.forEach((actionLabel) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "btn-option";
        button.textContent = actionLabel;
        button.addEventListener("click", () => {
          input.value = actionLabel;
          autoResizeInput();
          handleUserMessage(actionLabel);
        });
        actionsWrap.appendChild(button);
      });

      article.appendChild(actionsWrap);
    },
  };
}

async function appendBotMessage(answer, options = {}) {
  const message = createMessage({
    role: options.role || "bot",
    html: "",
    meta: options.meta,
    citations: options.citations || [],
    actions: options.actions || [],
  });

  const plainText = String(answer ?? "").replace(/\s+/g, " ").trim();
  const shouldSimulateTyping = options.simulateTyping !== false && (options.role || "bot") === "bot";

  if (!shouldSimulateTyping || plainText.length === 0) {
    message.bubble.innerHTML = formatAnswer(answer);
    message.appendMeta();
    message.appendCitations();
    message.appendActions();
    scrollMessagesToBottom();
    return;
  }

  const typingDelay = getTypingDelay(plainText.length);
  for (let index = 1; index <= plainText.length; index += 1) {
    message.bubble.textContent = plainText.slice(0, index);
    scrollMessagesToBottom();
    await wait(typingDelay);
  }

  message.bubble.innerHTML = formatAnswer(answer);
  message.appendMeta();
  message.appendCitations();
  message.appendActions();
  scrollMessagesToBottom();
}

function appendUserMessage(text) {
  createMessage({ role: "user", html: `<p>${escapeHtml(text)}</p>` });
}

function appendSystemMessage(text) {
  createMessage({ role: "system", html: `<p>${escapeHtml(text)}</p>` });
}

async function showQuickPrompts() {
  await appendBotMessage(translations.hint[state.currentLanguage], {
    actions: quickPrompts[state.currentLanguage],
    meta: translations.suggestionsTitle[state.currentLanguage],
    simulateTyping: false,
  });
}

function showTypingIndicator() {
  const wrapper = document.createElement("article");
  wrapper.className = "chat-message bot typing-message";
  wrapper.innerHTML = `
    <div class="message-role">NOVA.Bot</div>
    <div class="message-bubble">
      <span class="typing-dots"><span></span><span></span><span></span></span>
    </div>
  `;
  messages.appendChild(wrapper);
  scrollMessagesToBottom();
  return wrapper;
}

function removeTypingIndicator(node) {
  if (node && node.parentNode) {
    node.parentNode.removeChild(node);
  }
}

async function getBackendResponse(question) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question,
        language: state.currentLanguage,
        sessionId: state.currentSessionId,
      }),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);

    if (error?.name === "AbortError") {
      const timeoutError = new Error("REQUEST_TIMEOUT");
      timeoutError.code = "REQUEST_TIMEOUT";
      throw timeoutError;
    }

    const networkError = new Error("NETWORK_ERROR");
    networkError.code = "NETWORK_ERROR";
    throw networkError;
  }

  clearTimeout(timer);

  const data = await response.json().catch(() => ({}));

  if (response.status === 403 && (data?.blocked || typeof data?.answer === "string")) {
    return {
      ...data,
      blocked: true,
      reason: data?.reason || "out_of_domain",
    };
  }

  if (!response.ok) {
    const backendError = new Error(data?.error || `HTTP ${response.status}`);
    backendError.code = "BACKEND_ERROR";
    backendError.status = response.status;
    throw backendError;
  }

  return data;
}

async function maybeShowTopicSuggestions(question, responseData) {
  const normalized = question.toLowerCase();
  const answer = String(responseData?.answer ?? "");

  if (normalized.includes("reconhecimento") && answer.includes("A qual deles se refere?")) {
    await appendBotMessage(answer, {
      actions: [
        "Reconhecimento automático",
        "Reconhecimento de nível",
        "Reconhecimento específico",
      ],
      simulateTyping: true,
    });
    return true;
  }

  return false;
}

async function handleUserMessage(rawText) {
  const text = String(rawText ?? "").trim();
  if (!text || state.isWaitingResponse) {
    if (!text) appendSystemMessage(translations.empty[state.currentLanguage]);
    return;
  }

  appendUserMessage(text);
  input.value = "";
  autoResizeInput();
  setLoadingState(true);
  const typingIndicator = showTypingIndicator();

  try {
    const responseData = await getBackendResponse(text);
    removeTypingIndicator(typingIndicator);

    if (await maybeShowTopicSuggestions(text, responseData)) {
      return;
    }

    if (responseData?.blocked) {
      await appendBotMessage(responseData.answer || translations.blocked[state.currentLanguage], {
        meta: responseData.reason || "blocked",
        actions: quickPrompts[state.currentLanguage],
      });
      return;
    }

    await appendBotMessage(responseData.answer || translations.error[state.currentLanguage], {
      citations: responseData.citations || [],
    });
  } catch (error) {
    removeTypingIndicator(typingIndicator);
    console.error("Erro ao obter resposta do backend:", error);
    let errorMessage = translations.error[state.currentLanguage];
    let errorMeta = null;

    if (error?.code === "NETWORK_ERROR") {
      errorMessage = translations.offline[state.currentLanguage];
      errorMeta = "network";
    } else if (error?.code === "REQUEST_TIMEOUT") {
      errorMessage = translations.timeout[state.currentLanguage];
      errorMeta = "timeout";
    } else if (error?.code === "BACKEND_ERROR") {
      errorMessage = error.message || translations.error[state.currentLanguage];
      errorMeta = error.status ? `HTTP ${error.status}` : "backend";
    }

    await appendBotMessage(errorMessage, {
      role: "system",
      meta: errorMeta,
      actions: quickPrompts[state.currentLanguage],
      simulateTyping: false,
    });
  } finally {
    setLoadingState(false);
    input.focus();
  }
}

function resetChat() {
  messages.innerHTML = "";
  state.currentSessionId = createSessionId();
  appendSystemMessage(translations.reset[state.currentLanguage]);
  appendBotMessage(translations.welcome[state.currentLanguage]);
}

function updateUiLanguage() {
  input.placeholder = translations.placeholder[state.currentLanguage];

  if (botWindow.classList.contains("open") && !messages.children.length) {
    appendBotMessage(translations.welcome[state.currentLanguage]);
  }
}

function toggleAccessibilityMenu() {
  accessibilityMenu.classList.toggle("hidden");
}

function applyFontScale() {
  botWindow.style.setProperty("--chat-font-scale", String(state.fontScale));
}

function adjustFontScale(delta) {
  state.fontScale = Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, state.fontScale + delta));
  applyFontScale();
}

function toggleAccessibleTheme() {
  state.isAccessibleTheme = !state.isAccessibleTheme;
  botWindow.classList.toggle("accessible-theme", state.isAccessibleTheme);
}

sendBtn.addEventListener("click", () => handleUserMessage(input.value));

input.addEventListener("input", autoResizeInput);
input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    handleUserMessage(input.value);
  }
});

resetBtn.addEventListener("click", resetChat);

languageSelect.addEventListener("change", (event) => {
  state.currentLanguage = event.target.value;
  updateUiLanguage();
});

optionsToggle.addEventListener("click", toggleAccessibilityMenu);
increaseFontBtn.addEventListener("click", () => adjustFontScale(FONT_SCALE_STEP));
decreaseFontBtn.addEventListener("click", () => adjustFontScale(-FONT_SCALE_STEP));
toggleThemeBtn.addEventListener("click", toggleAccessibleTheme);

document.addEventListener("click", (event) => {
  if (!event.target.closest(".options-menu-wrapper")) {
    accessibilityMenu.classList.add("hidden");
  }
});

botButton.addEventListener("click", () => {
  const isOpen = botWindow.classList.toggle("open");
  botButton.classList.toggle("active", isOpen);

  if (isOpen && !messages.children.length) {
    appendBotMessage(translations.welcome[state.currentLanguage]);
  }

  if (isOpen) {
    input.focus();
  }
});

applyFontScale();
updateUiLanguage();
autoResizeInput();
