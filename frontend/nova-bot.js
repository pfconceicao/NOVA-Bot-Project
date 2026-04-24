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
const TRANSLATE_API_URL = "http://localhost:3000/translate";
const FONT_SCALE_MIN = 0.9;
const FONT_SCALE_MAX = 1.2;
const FONT_SCALE_STEP = 0.05;
const TYPEWRITER_MIN_DELAY_MS = 8;
const TYPEWRITER_MAX_DELAY_MS = 20;
const THINKING_DELAY_MIN_MS = 420;
const THINKING_DELAY_MAX_MS = 760;
const REQUEST_TIMEOUT_MS = 90000;

const state = {
  currentLanguage: languageSelect.value,
  currentSessionId: createSessionId(),
  fontScale: 1,
  isAccessibleTheme: false,
  isWaitingResponse: false,
  chatVersion: 0,
  chatHistory: [],
};

const translations = {
  welcome: {
    pt: "Olá. Sou o NiA, o assistente virtual de informação da NOVA. Pode escrever diretamente a sua pergunta ou, se preferir, ver alguns tópicos para começar.",
    en: "Hello. I am NiA, NOVA's virtual information assistant. You can type your question directly or, if you prefer, view a few topics to get started.",
  },
  hint: {
    pt: "Aqui tem alguns tópicos por onde pode começar.",
    en: "Here are a few topics you can start with.",
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
  suggestionsCta: {
    pt: "Se preferir, posso sugerir alguns tópicos para começar.",
    en: "If you prefer, I can suggest a few topics to get started.",
  },
  showSuggestionsButton: {
    pt: "Ver sugestões",
    en: "Show suggestions",
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

const FAST_TRANSLATION_PAIRS = [
  ["reconhecimento", "recognition"],
  ["reconhecimento automático", "automatic recognition"],
  ["reconhecimento de nível", "level recognition"],
  ["reconhecimento específico", "specific recognition"],
  [
    "Há três tipos de reconhecimento de graus e diplomas estrangeiros:\n• Reconhecimento automático\n• Reconhecimento de nível\n• Reconhecimento específico\n\nPosso dar mais detalhe sobre qualquer um deles.\n\nQual deles pretende indicar?",
    "There are three types of recognition for foreign degrees and diplomas:\n• Automatic recognition\n• Level recognition\n• Specific recognition\n\nI can clarify any of them.\n\nWhich one do you want to know about?"
  ],
  [
    "Existem três tipos de reconhecimento de graus e diplomas estrangeiros:\n• Reconhecimento automático\n• Reconhecimento de nível\n• Reconhecimento específico\n\nPosso esclarecer qualquer um deles.\n\nA qual deles se refere?",
    "There are three types of recognition for foreign degrees and diplomas:\n• Automatic recognition\n• Level recognition\n• Specific recognition\n\nI can clarify any of them.\n\nWhich one do you want to know about?"
  ],
  ["qual é o horário da uaa?", "what are the uaa opening hours?"],
  ["horário uaa", "uaa opening hours"],
  ["o que é o reconhecimento automático?", "what is automatic recognition?"],
  ["que documentos entregar para reconhecimento de nível?", "which documents are required for level recognition?"],
  ["quanto custa o reconhecimento específico?", "how much does specific recognition cost?"],
  ["custos", "fees"],
  ["documentos", "documents"],
  ["onde solicitar", "where to apply"],
  ["prazo", "timeline"],
];

const FAST_TRANSLATIONS = buildFastTranslations();

function createSessionId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `nova-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function normalizeLookupText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function buildFastTranslations() {
  const map = new Map();

  FAST_TRANSLATION_PAIRS.forEach(([ptText, enText]) => {
    map.set(`pt:en:${normalizeLookupText(ptText)}`, enText);
    map.set(`en:pt:${normalizeLookupText(enText)}`, ptText);
  });

  quickPrompts.pt.forEach((ptPrompt, index) => {
    const enPrompt = quickPrompts.en[index];
    map.set(`pt:en:${normalizeLookupText(ptPrompt)}`, enPrompt);
    map.set(`en:pt:${normalizeLookupText(enPrompt)}`, ptPrompt);
  });

  return map;
}

function getFastTranslation(text, sourceLanguage, targetLanguage) {
  const normalizedText = normalizeLookupText(text);
  if (!normalizedText) return "";

  return FAST_TRANSLATIONS.get(`${sourceLanguage}:${targetLanguage}:${normalizedText}`) || "";
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
  return text.replace(/(https?:\/\/[^\s<]+)/g, (match) => {
    const parts = String(match).match(/^(https?:\/\/[^\s<]*?)([.),\];:!?]+)?$/);
    const href = parts?.[1] || match;
    const trailing = parts?.[2] || "";
    return `<a href="${href}" target="_blank" rel="noreferrer noopener">${href}</a>${trailing}`;
  });
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

function highlightExistingEntry(node) {
  if (!node) return;

  node.classList.remove("message-rehighlight");
  void node.offsetWidth;
  node.classList.add("message-rehighlight");

  window.setTimeout(() => {
    node.classList.remove("message-rehighlight");
  }, 1400);
}

function normalizeAction(actionItem) {
  if (typeof actionItem === "string") {
    return {
      label: actionItem,
      value: actionItem,
      userText: actionItem,
      submitValue: actionItem,
      type: null,
      appearance: null,
      localizedLabels: null,
      localizedUserTexts: null,
      localizedSubmitValues: null,
    };
  }

  return {
    label: String(actionItem?.label ?? actionItem?.value ?? ""),
    value: String(actionItem?.value ?? actionItem?.label ?? ""),
    userText: String(actionItem?.userText ?? actionItem?.label ?? actionItem?.value ?? ""),
    submitValue: String(actionItem?.submitValue ?? actionItem?.value ?? actionItem?.label ?? ""),
    type: actionItem?.type || null,
    appearance: actionItem?.appearance || null,
    localizedLabels: actionItem?.localizedLabels || null,
    localizedUserTexts: actionItem?.localizedUserTexts || null,
    localizedSubmitValues: actionItem?.localizedSubmitValues || null,
  };
}

function cloneActions(actions = []) {
  return actions.map((actionItem) => ({ ...normalizeAction(actionItem) }));
}

function getAlternateLanguage(language) {
  return language === "pt" ? "en" : "pt";
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getTypingDelay(textLength) {
  if (textLength > 280) return TYPEWRITER_MIN_DELAY_MS;
  if (textLength > 140) return 12;
  return TYPEWRITER_MAX_DELAY_MS;
}

function getThinkingDelay(textLength) {
  if (textLength > 280) return THINKING_DELAY_MAX_MS;
  if (textLength > 140) return 620;
  return THINKING_DELAY_MIN_MS;
}

function setLoadingState(isLoading) {
  state.isWaitingResponse = isLoading;
  sendBtn.disabled = isLoading;
  input.disabled = isLoading;
}

function createMessage({ role, html, meta, citations = [], actions = [], entryKey = "" }) {
  const article = document.createElement("article");
  article.className = `chat-message ${role}`;
  if (entryKey) {
    article.dataset.entryKey = entryKey;
  }

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

      actions.forEach((actionItem) => {
        if (actionItem?.type === "showQuickPrompts") {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "btn-option";
          if (actionItem?.appearance === "subtle") {
            button.classList.add("subtle");
          }
          button.textContent = String(actionItem?.label ?? "");
          button.addEventListener("click", () => {
            void showQuickPrompts();
          });
          actionsWrap.appendChild(button);
          return;
        }

        const actionLabel = typeof actionItem === "string" ? actionItem : String(actionItem?.label ?? actionItem?.value ?? "");
        const actionValue = typeof actionItem === "string" ? actionItem : String(actionItem?.value ?? actionItem?.label ?? "");
        const actionSubmitValue = typeof actionItem === "string" ? actionValue : String(actionItem?.submitValue ?? actionValue);
        const actionUserText = typeof actionItem === "string" ? actionValue : String(actionItem?.userText ?? actionLabel);
        if (!actionLabel || !actionValue) return;

        const button = document.createElement("button");
        button.type = "button";
        button.className = "btn-option";
        button.textContent = actionLabel;
        button.addEventListener("click", () => {
          input.value = actionUserText;
          autoResizeInput();
          handleUserMessage(actionUserText, actionSubmitValue, {
            localizedUserTexts: actionItem?.localizedUserTexts || null,
            localizedSubmitValues: actionItem?.localizedSubmitValues || null,
          });
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
    entryKey: options.entryKey || "",
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

async function requestTranslation(text, sourceLanguage, targetLanguage) {
  const trimmedText = String(text ?? "").trim();
  if (!trimmedText || sourceLanguage === targetLanguage) return trimmedText;

  const fastTranslation = getFastTranslation(trimmedText, sourceLanguage, targetLanguage);
  if (fastTranslation) return fastTranslation;

  const response = await fetch(TRANSLATE_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: trimmedText,
      sourceLanguage,
      targetLanguage,
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error || `HTTP ${response.status}`);
  }

  return String(data?.text ?? trimmedText).trim();
}

function buildQuickPromptActions(language) {
  const alternateLanguage = getAlternateLanguage(language);

  return quickPrompts[language].map((prompt, index) => ({
    label: prompt,
    value: prompt,
    userText: prompt,
    submitValue: prompt,
    type: null,
    localizedLabels: {
      [language]: prompt,
      [alternateLanguage]: quickPrompts[alternateLanguage][index],
    },
    localizedUserTexts: {
      [language]: prompt,
      [alternateLanguage]: quickPrompts[alternateLanguage][index],
    },
    localizedSubmitValues: {
      [language]: prompt,
      [alternateLanguage]: quickPrompts[alternateLanguage][index],
    },
  }));
}

function buildSuggestionCtaActions(language) {
  return [{
    label: translations.showSuggestionsButton[language],
    value: translations.showSuggestionsButton[language],
    userText: translations.showSuggestionsButton[language],
    submitValue: translations.showSuggestionsButton[language],
    type: "showQuickPrompts",
    appearance: "subtle",
  }];
}

async function localizeActionsForEntry(entry, language) {
  if (entry.actionPreset === "quickPrompts") {
    return buildQuickPromptActions(language);
  }

  if (entry.actionPreset === "suggestionsCta") {
    return buildSuggestionCtaActions(language);
  }

  const originalActions = cloneActions(entry.originalActions || []);
  if (!originalActions.length) return [];
  if (entry.localizedActions?.[language]) return cloneActions(entry.localizedActions[language]);
  if (entry.originalLanguage === language) return originalActions;

  const localizedActions = await Promise.all(originalActions.map(async (actionItem) => ({
    ...actionItem,
    label: await requestTranslation(actionItem.label, entry.originalLanguage, language),
    value: await requestTranslation(actionItem.value, entry.originalLanguage, language),
    userText: await requestTranslation(actionItem.userText, entry.originalLanguage, language),
    submitValue: await requestTranslation(actionItem.submitValue, entry.originalLanguage, language),
  })));

  entry.localizedActions[language] = cloneActions(localizedActions);

  return localizedActions;
}

async function localizeEntryText(entry, language) {
  if (entry.i18nKey) {
    return translations[entry.i18nKey][language];
  }

  if (entry.localizedTexts?.[language]) {
    return entry.localizedTexts[language];
  }

  if (entry.originalLanguage === language) {
    return entry.originalText;
  }

  const localizedText = await requestTranslation(entry.originalText, entry.originalLanguage, language);
  entry.localizedTexts[language] = localizedText;
  return localizedText;
}

async function localizeSourceQuestion(entry, language) {
  if (!entry.sourceQuestion) return "";

  if (entry.localizedQuestions?.[language]) {
    return entry.localizedQuestions[language];
  }

  const localizedQuestion = entry.originalLanguage === language
    ? entry.sourceQuestion
    : await requestTranslation(entry.sourceQuestion, entry.originalLanguage, language);

  entry.localizedQuestions[language] = localizedQuestion;
  return localizedQuestion;
}

async function localizeBotEntryFromBackend(entry, language) {
  if (!entry.sourceQuestion) return false;

  const requestQuestion = String(entry.sourceQuestion ?? "").trim();
  if (!requestQuestion) return false;

  const responseData = await getBackendResponse(requestQuestion, {
    language,
    sessionId: null,
  });

  entry.localizedTexts[language] = String(responseData?.answer ?? "").trim();
  entry.localizedActions[language] = cloneActions(responseData?.actions || []);

  if (!entry.localizedQuestions?.[language]) {
    void localizeSourceQuestion(entry, language).catch(() => {
      // The bot answer can still be regenerated even if translating the original user question fails.
    });
  }

  return true;
}

function localizeEntryMeta(entry, language) {
  if (entry.metaI18nKey) {
    return translations[entry.metaI18nKey][language];
  }

  return entry.meta || null;
}

async function renderHistoryEntry(entry, options = {}) {
  const text = await localizeEntryText(entry, state.currentLanguage);
  const meta = localizeEntryMeta(entry, state.currentLanguage);
  const actions = await localizeActionsForEntry(entry, state.currentLanguage);

  if (entry.role === "user") {
    createMessage({ role: "user", html: `<p>${escapeHtml(text)}</p>`, entryKey: entry.entryKey });
    return;
  }

  if (entry.role === "system") {
    createMessage({ role: "system", html: `<p>${escapeHtml(text)}</p>`, entryKey: entry.entryKey });
    return;
  }

  await appendBotMessage(text, {
    entryKey: entry.entryKey,
    meta,
    citations: entry.citations || [],
    actions,
    simulateTyping: options.simulateTyping ?? (entry.simulateTyping !== false),
  });
}

async function ensureEntryLocalized(entry, language) {
  if (entry.i18nKey || entry.originalLanguage === language) return;

  entry.pendingLocalizations = entry.pendingLocalizations || {};
  if (entry.pendingLocalizations[language]) {
    await Promise.race([
      entry.pendingLocalizations[language],
      wait(1200),
    ]);
    return;
  }

  if (entry.localizedTexts?.[language] && (entry.localizedActions?.[language] || !(entry.originalActions || []).length)) {
    return;
  }

  entry.pendingLocalizations[language] = (async () => {
    if (entry.role === "bot" && await localizeBotEntryFromBackend(entry, language)) {
      return;
    }

    await Promise.all([
      localizeEntryText(entry, language),
      localizeActionsForEntry(entry, language),
    ]);
  })().finally(() => {
    delete entry.pendingLocalizations[language];
  });

  await entry.pendingLocalizations[language];
}

function primeEntryLocalization(entry) {
  if (entry.i18nKey) return;

  // Do not compete with the visible reply by regenerating bot messages in the background.
  if (entry.role === "bot") return;

  const targetLanguage = getAlternateLanguage(entry.originalLanguage);
  void ensureEntryLocalized(entry, targetLanguage).catch((error) => {
    console.warn("Falha a pré-carregar tradução da mensagem:", error);
  });
}

async function addMessageEntry(entry) {
  const entryLanguage = entry.originalLanguage || state.currentLanguage;
  const localizedTexts = entry.localizedTexts
    ? { ...entry.localizedTexts }
    : {};
  if (!entry.i18nKey) {
    localizedTexts[entryLanguage] = entry.originalText || "";
  }

  const localizedQuestions = entry.localizedQuestions
    ? { ...entry.localizedQuestions }
    : {};
  if (entry.sourceQuestion) {
    localizedQuestions[entryLanguage] = entry.sourceQuestion;
  }

  const normalizedEntry = {
    entryKey: entry.entryKey || `entry-${Date.now()}-${state.chatHistory.length + 1}`,
    role: entry.role || "bot",
    originalText: entry.originalText || "",
    originalLanguage: entryLanguage,
    meta: entry.meta || null,
    metaI18nKey: entry.metaI18nKey || null,
    citations: entry.citations || [],
    originalActions: cloneActions(entry.originalActions || []),
    i18nKey: entry.i18nKey || null,
    actionPreset: entry.actionPreset || null,
    simulateTyping: entry.simulateTyping,
    localizedTexts: entry.i18nKey ? {} : localizedTexts,
    localizedActions: { [entryLanguage]: cloneActions(entry.originalActions || []) },
    sourceQuestion: entry.sourceQuestion || "",
    localizedQuestions,
    pendingLocalizations: {},
  };

  state.chatHistory.push(normalizedEntry);
  primeEntryLocalization(normalizedEntry);
  await renderHistoryEntry(normalizedEntry);
}

async function renderChatHistory(options = {}) {
  messages.innerHTML = "";
  for (const entry of state.chatHistory) {
    await renderHistoryEntry(entry, options);
  }
}

async function showQuickPrompts() {
  const existingEntry = state.chatHistory.find((entry) => entry.actionPreset === "quickPrompts");
  if (existingEntry?.entryKey) {
    const existingNode = messages.querySelector(`[data-entry-key="${existingEntry.entryKey}"]`);
    if (existingNode) {
      existingNode.scrollIntoView({ behavior: "smooth", block: "center" });
      highlightExistingEntry(existingNode);
      return;
    }
  }

  await addMessageEntry({
    role: "bot",
    i18nKey: "hint",
    metaI18nKey: "suggestionsTitle",
    actionPreset: "quickPrompts",
    simulateTyping: false,
  });
}

function resetChatUiState({ closeWindow = false } = {}) {
  state.chatVersion += 1;
  state.currentSessionId = createSessionId();
  state.chatHistory = [];
  messages.innerHTML = "";
  setLoadingState(false);

  if (closeWindow) {
    botWindow.classList.remove("open");
    botButton.classList.remove("active");
  }
}

async function initializeChat({ announceReset = false } = {}) {
  resetChatUiState();

  if (announceReset) {
    await addMessageEntry({
      role: "system",
      i18nKey: "reset",
    });
  }

  await addMessageEntry({
    role: "bot",
    i18nKey: "welcome",
    actionPreset: "suggestionsCta",
    simulateTyping: true,
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

async function getBackendResponse(question, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const requestLanguage = options.language || state.currentLanguage;
  const requestSessionId = Object.prototype.hasOwnProperty.call(options, "sessionId")
    ? options.sessionId
    : state.currentSessionId;

  let response;
  try {
    response = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question,
        language: requestLanguage,
        sessionId: requestSessionId,
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

function isStaleChatVersion(version) {
  return version !== state.chatVersion;
}

async function maybeShowTopicSuggestions(question, responseData) {
  const answer = String(responseData?.answer ?? "");
  const answerNorm = answer
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  const hasRecognitionTypeList =
    answerNorm.includes("reconhecimento automatico") &&
    answerNorm.includes("reconhecimento de nivel") &&
    answerNorm.includes("reconhecimento especifico");

  const asksToChooseRecognitionType =
    answerNorm.includes("a qual deles se refere") ||
    answerNorm.includes("qual deles pretende indicar") ||
    answerNorm.includes("qual deles pretende que eu explique") ||
    answerNorm.includes("qual deles quer que eu explique");

  if (hasRecognitionTypeList && asksToChooseRecognitionType) {
    await addMessageEntry({
      role: "bot",
      originalText: answer,
      originalLanguage: state.currentLanguage,
      sourceQuestion: question,
      originalActions: responseData?.actions || [
        { label: "Reconhecimento automático", value: "O que é o reconhecimento automático?" },
        { label: "Reconhecimento de nível", value: "O que é o reconhecimento de nível?" },
        { label: "Reconhecimento específico", value: "O que é o reconhecimento específico?" },
      ],
    });
    return true;
  }

  return false;
}

async function handleUserMessage(rawText, submittedText = rawText, options = {}) {
  const text = String(rawText ?? "").trim();
  const questionToSend = String(submittedText ?? rawText ?? "").trim();
  if (!text || state.isWaitingResponse) {
    if (!text) appendSystemMessage(translations.empty[state.currentLanguage]);
    return;
  }

  await addMessageEntry({
    role: "user",
    originalText: text,
    originalLanguage: state.currentLanguage,
    localizedTexts: options.localizedUserTexts || null,
    meta: null,
    metaI18nKey: null,
    citations: [],
    originalActions: [],
    i18nKey: null,
    actionPreset: null,
  });
  input.value = "";
  autoResizeInput();
  setLoadingState(true);
  const typingIndicator = showTypingIndicator();
  const chatVersion = state.chatVersion;

  try {
    const responseData = await getBackendResponse(questionToSend);
    if (isStaleChatVersion(chatVersion)) return;

    await wait(getThinkingDelay(String(responseData?.answer ?? "").length));
    if (isStaleChatVersion(chatVersion)) return;

    removeTypingIndicator(typingIndicator);

    if (await maybeShowTopicSuggestions(text, responseData)) {
      return;
    }

    if (responseData?.blocked) {
      await addMessageEntry({
        role: "bot",
        originalText: responseData.answer || translations.blocked[state.currentLanguage],
        originalLanguage: state.currentLanguage,
        sourceQuestion: questionToSend,
        localizedQuestions: options.localizedSubmitValues || null,
      });
      return;
    }

    await addMessageEntry({
      role: "bot",
      originalText: responseData.answer || translations.error[state.currentLanguage],
      originalLanguage: state.currentLanguage,
      sourceQuestion: questionToSend,
      localizedQuestions: options.localizedSubmitValues || null,
      citations: responseData.citations || [],
      originalActions: responseData.actions || [],
    });
  } catch (error) {
    removeTypingIndicator(typingIndicator);
    if (isStaleChatVersion(chatVersion)) return;

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

    await addMessageEntry({
      role: "system",
      originalText: errorMessage,
      originalLanguage: state.currentLanguage,
      meta: errorMeta,
    });
    await showQuickPrompts();
  } finally {
    if (!isStaleChatVersion(chatVersion)) {
      setLoadingState(false);
      input.focus();
    }
  }
}

function resetChat({ announce = true } = {}) {
  void initializeChat({ announceReset: announce });
}

async function updateUiLanguage() {
  document.documentElement.lang = state.currentLanguage;
  input.placeholder = translations.placeholder[state.currentLanguage];

  if (botWindow.classList.contains("open") && !messages.children.length) {
    await initializeChat({ announceReset: false });
    return;
  }

  if (!state.chatHistory.length) return;

  state.chatVersion += 1;
  setLoadingState(false);
  document.querySelectorAll(".typing-message").forEach((node) => node.remove());
  const chatVersion = state.chatVersion;

  try {
    await Promise.allSettled(state.chatHistory.map((entry) => ensureEntryLocalized(entry, state.currentLanguage)));
    if (isStaleChatVersion(chatVersion)) return;
    await renderChatHistory({ simulateTyping: false });
  } catch (error) {
    console.error("Erro ao traduzir histórico:", error);
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

resetBtn.addEventListener("click", () => resetChat());

languageSelect.addEventListener("change", (event) => {
  state.currentLanguage = event.target.value;
  void updateUiLanguage();
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

  if (!isOpen) {
    resetChatUiState({ closeWindow: true });
    return;
  }

  if (isOpen && !messages.children.length) {
    void initializeChat({ announceReset: false });
  }

  if (isOpen) {
    input.focus();
  }
});

applyFontScale();
resetChatUiState({ closeWindow: true });
void updateUiLanguage();
autoResizeInput();

window.addEventListener("pageshow", (event) => {
  if (event.persisted) {
    resetChatUiState({ closeWindow: true });
    void updateUiLanguage();
  }
});
