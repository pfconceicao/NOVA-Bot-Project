// nova-bot-server.js
// Requer Node 18+ (fetch global). Para Node < 18: descomenta node-fetch.

import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import { pipeline } from "@xenova/transformers";
import fs from "fs";
import path from "path";
import readline from "readline";

// Node < 18: descomenta
// import fetch from "node-fetch";

const PORT = 3000;
const indexFolder = path.resolve("./index_docs");
const modelPath = "Xenova/all-MiniLM-L6-v2";
const OLLAMA_HOST = process.env.OLLAMA_HOST || "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "mistral";

const TOP_K = 5;
const MIN_SIMILARITY = 0.15;

const MAX_CONTEXT_CHARS = 6500;

const FALLBACK = "Não encontrei informação relevante nos documentos disponíveis.";
const OUT_OF_DOMAIN_MESSAGE =
  "Pergunta fora do âmbito académico da NOVA. Posso ajudar com reconhecimento, candidaturas, propinas, alojamento universitário e serviços académicos.";
const recognitionContentPath = path.resolve("./data/recognition-content.json");
const RECOGNITION_CONTENT = loadRecognitionContent(recognitionContentPath);
const RECOGNITION_LINKS = RECOGNITION_CONTENT?.links ?? {};
const EMOLUMENTS_URL =
  RECOGNITION_LINKS.emolumentsUrl ||
  "https://www.unl.pt/sites/default/files/deliberacao_702_2020_atualizacao_tabela_emolumentos.pdf";
const RESPONSE_CACHE_TTL_MS = 30 * 60 * 1000;
const RESPONSE_CACHE_MAX_ENTRIES = 300;

function loadRecognitionContent(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Falha ao carregar recognition-content.json: ${String(err?.message ?? err)}`);
  }
}

function interpolateTemplate(template, context = {}) {
  return String(template ?? "").replace(/{{(\w+)}}/g, (_, key) => String(context[key] ?? ""));
}

function hashString(value) {
  const input = String(value ?? "");
  let hash = 0;

  for (let index = 0; index < input.length; index++) {
    hash = (hash * 31 + input.charCodeAt(index)) >>> 0;
  }

  return hash;
}

function pickVariantText(value, variantScope = "", variantKey = "") {
  const variants = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray(value.variants)
      ? value.variants
      : [value];

  const normalized = variants
    .map((entry) => String(entry ?? "").trim())
    .filter(Boolean);

  if (normalized.length === 0) return "";
  if (normalized.length === 1) return normalized[0];

  const variantHash = hashString(`${variantScope}::${variantKey}`);
  return normalized[variantHash % normalized.length];
}

function getRecognitionTemplateContext(extra = {}) {
  return {
    ...RECOGNITION_LINKS,
    ...extra,
  };
}

function getRecognitionGeneralText(key, variantScope = "") {
  return interpolateTemplate(
    pickVariantText(RECOGNITION_CONTENT?.general?.[key] ?? "", variantScope, `general:${key}`),
    getRecognitionTemplateContext()
  );
}

function getRecognitionTypeText(typeKey, key, variantScope = "") {
  return interpolateTemplate(
    pickVariantText(RECOGNITION_CONTENT?.types?.[typeKey]?.[key] ?? "", variantScope, `type:${typeKey}:${key}`),
    getRecognitionTemplateContext()
  );
}

function getRecognitionContactText(contactKey, responseKey, extra = {}, variantScope = "") {
  const contact = RECOGNITION_CONTENT?.contacts?.[contactKey] ?? {};
  return interpolateTemplate(
    pickVariantText(contact?.[responseKey] ?? "", variantScope, `contact:${contactKey}:${responseKey}`),
    getRecognitionTemplateContext({ ...contact, ...extra })
  );
}

async function checkOllamaModelAvailability() {
  try {
    const resp = await fetch(`${OLLAMA_HOST}/api/tags`);

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      console.warn(`⚠️ Não foi possível validar modelos do Ollama (${resp.status} ${resp.statusText}) ${text}`);
      return;
    }

    const data = await resp.json();
    const installedModels = Array.isArray(data?.models) ? data.models : [];
    const hasConfiguredModel = installedModels.some((entry) => {
      const name = String(entry?.name ?? "").toLowerCase();
      return name === OLLAMA_MODEL.toLowerCase() || name.startsWith(`${OLLAMA_MODEL.toLowerCase()}:`);
    });

    if (hasConfiguredModel) {
      console.log(`🤖 Ollama pronto com o modelo \"${OLLAMA_MODEL}\"`);
      return;
    }

    const available = installedModels
      .map((entry) => String(entry?.name ?? "").trim())
      .filter(Boolean)
      .join(", ");

    console.warn(`⚠️ Modelo Ollama configurado não encontrado: \"${OLLAMA_MODEL}\"`);
    console.warn(`   Define OLLAMA_MODEL ou instala-o com: ollama pull ${OLLAMA_MODEL}`);
    console.warn(`   Modelos disponíveis: ${available || "nenhum"}`);
  } catch (err) {
    console.warn(`⚠️ Não foi possível contactar o Ollama em ${OLLAMA_HOST}: ${String(err?.message ?? err)}`);
  }
}

// ───────── Config patch fundação ─────────
const FOUNDATION_SHORTCUT_TOP_N = 500; // quantos chunks considerar no atalho rápido
const FOUNDATION_SHORTCUT_TWO_SENTENCES = true; // true => tenta devolver 2 frases (fundação + regime)

const DOMAIN_KEYWORDS = [
  "nova",
  "universidade",
  "faculdade",
  "curso",
  "ensino",
  "investigação",
  "docente",
  "estudante",
  "estatuto",
  "estatutos",
  "instituto",
  "departamento",
  "unidade",
  "academico",
  "académico",
  "órgão",
  "órgãos",
  "orgaos",
  "conselho",
  "reitor",
  "reitoria",
  "colégio",
  "colegio",
  "diretor",
  "director",
  "diretores",
  "directores",
  "direção",
  "direcao",
  "senado",
  "curadores",
  "provedor",
  "estágio",
  "estágios",
  "bolsa",
  "bolsas",
  "alojamento",
  "reconhecimento",
  "reconhecimentos",
  "emolumento",
  "emolumentos",
  "crédito",
  "créditos",
  "tempo",
  "dias",
  "semanas",
  "meses",
  "prazo",
  "duração",
  "demora",
  "processo",
  "pedido",
  "solicitar",
  "requerimento",
  "documento",
  "formulário",
];

// ───────── Gestão de sessões para contexto de conversa ─────────
const sessionContext = new Map();
const sessionPendingState = new Map();
const sessionLastIntent = new Map();
const responseCache = new Map();

function buildResponseCacheKey(questionNorm, topicNorm = "", responseScope = "global") {
  return `${responseScope}::${topicNorm}::${questionNorm}`;
}

function getCachedResponse(cacheKey) {
  const entry = responseCache.get(cacheKey);
  if (!entry) return null;

  if (Date.now() - entry.createdAt > RESPONSE_CACHE_TTL_MS) {
    responseCache.delete(cacheKey);
    return null;
  }

  return {
    statusCode: entry.statusCode,
    payload: JSON.parse(JSON.stringify(entry.payload)),
    pendingState: entry.pendingState ?? null,
  };
}

function setCachedResponse(cacheKey, statusCode, payload, pendingState = null) {
  if (!cacheKey) return;

  if (responseCache.size >= RESPONSE_CACHE_MAX_ENTRIES) {
    const oldestKey = responseCache.keys().next().value;
    if (oldestKey) responseCache.delete(oldestKey);
  }

  responseCache.set(cacheKey, {
    statusCode,
    payload: JSON.parse(JSON.stringify(payload)),
    pendingState,
    createdAt: Date.now(),
  });
}

function buildScopedChunkPool(chunks, lowerNorm, topicNorm = "") {
  const scope = `${topicNorm} ${lowerNorm}`;

  const filterByNeedles = (needles) => {
    const filtered = chunks.filter((chunk) => {
      const hay = stripDiacriticsLower(
        `${chunk.text ?? ""} ${chunk.relativePath ?? ""} ${chunk.file ?? ""} ${chunk.category ?? ""}`
      );
      return needles.some((needle) => hay.includes(needle));
    });

    return filtered.length >= 5 ? filtered : chunks;
  };

  if (
    scope.includes("reconhecimento") ||
    scope.includes("emolumento") ||
    scope.includes("propina") ||
    scope.includes("dges")
  ) {
    return filterByNeedles(["reconhecimento", "dges", "emolumento", "propina"]);
  }

  if (
    scope.includes("alojamento") ||
    scope.includes("residencia") ||
    scope.includes("sasnova")
  ) {
    return filterByNeedles(["alojamento", "residencia", "sasnova"]);
  }

  if (
    scope.includes("servicos academicos") ||
    scope.includes("uaa") ||
    scope.includes("assuntos academicos") ||
    scope.includes("reitoria")
  ) {
    return filterByNeedles(["servicos academicos", "uaa", "assuntos academicos", "reitoria"]);
  }

  if (scope.includes("fundacao") || scope.includes("direito privado")) {
    return filterByNeedles(["fundacao", "direito privado", "regime"]);
  }

  if (scope.includes("estatuto") || scope.includes("colegio") || scope.includes("director")) {
    return filterByNeedles(["estatuto", "colegio", "director", "diretor"]);
  }

  return chunks;
}

function detectRecognitionSubtypeShorthand(text) {
  const t = stripDiacriticsLower(text).trim();

  if (!t) return null;

  if (/^(?:e\s+)?(?:(?:do|de|o)\s+)?automatico$/.test(t)) return "automatico";
  if (/^(?:e\s+)?(?:(?:de|do|o)\s+)?nivel$/.test(t)) return "nivel";
  if (/^(?:e\s+)?(?:(?:do|de|o)\s+)?especifico$/.test(t)) return "especifico";

  return null;
}

function inferTopicFromQuestion(lower, previousTopic = "") {
  const t = stripDiacriticsLower(lower);
  const previous = stripDiacriticsLower(previousTopic);
  const hasRecognitionContext = previous.includes("reconhecimento");
  const recognitionSubtypeShorthand = detectRecognitionSubtypeShorthand(lower);

  if (
    t.includes("servicos academicos") ||
    t.includes("servico academico") ||
    t.includes("uaa") ||
    t.includes("unidade de assuntos academicos") ||
    t.includes("assuntos academicos") ||
    t.includes("reitoria")
  ) {
    return "serviços académicos";
  }

  // Reconhecimento automático
  if (t.includes("reconhecimento") && t.includes("automatico"))
    return "reconhecimento automático";

  // Reconhecimento de nível
  if (t.includes("reconhecimento") && t.includes("nivel")) return "reconhecimento de nível";

  // Reconhecimento específico
  if (t.includes("reconhecimento") && t.includes("especifico"))
    return "reconhecimento específico";

  // Reconhecimento académico
  if (t.includes("reconhecimento") && (t.includes("academico") || t.includes("académico")))
    return "reconhecimento académico";

  // Reconhecimento genérico
  if (t.includes("reconhecimento"))
    return "reconhecimento";

  if (hasRecognitionContext) {
    if (recognitionSubtypeShorthand === "automatico") return "reconhecimento automático";
    if (recognitionSubtypeShorthand === "nivel") return "reconhecimento de nível";
    if (recognitionSubtypeShorthand === "especifico") return "reconhecimento específico";
    if (t.includes("automatico")) return "reconhecimento automático";
    if (t.includes("nivel")) return "reconhecimento de nível";
    if (t.includes("especifico")) return "reconhecimento específico";
  }

  // Alojamento
  if (t.includes("alojamento") || t.includes("residencia") || t.includes("residência"))
    return "alojamento";

  // Localização
  if (t.includes("onde") || t.includes("endereco") || t.includes("endereço") || t.includes("morada"))
    return "localização";

  return null;
}

function detectQuestionIntent(lower) {
  const q = stripDiacriticsLower(lower);

  const isTimeQuestion =
    q.includes("demora") ||
    q.includes("tempo") ||
    q.includes("prazo") ||
    q.includes("dias") ||
    q.includes("semanas") ||
    q.includes("meses");

  if (q.includes("o que e") || q.includes("definicao") || q.includes("define") || q.includes("significa")) {
    return "definition";
  }

  if (q.includes("graus") || q.includes("aplica") || q.includes("a que graus") || q.includes("quais graus")) {
    return "degrees";
  }

  if (q.includes("onde") || q.includes("como solicitar") || q.includes("onde solicitar") || q.includes("formulario")) {
    return "where";
  }

  if (
    q.includes("document") ||
    q.includes("entregar") ||
    q.includes("anexar") ||
    q.includes("diploma") ||
    q.includes("historico") ||
    q.includes("programa")
  ) {
    return "documents";
  }

  if (!isTimeQuestion && (q.includes("custa") || q.includes("custo") || q.includes("quanto") || q.includes("valor"))) {
    return "cost";
  }

  if (isTimeQuestion) {
    return "time";
  }

  return null;
}

function buildIntentCarryQuestion(intent, topic) {
  if (!intent || !topic) return null;

  switch (intent) {
    case "definition":
      return `o que e ${topic}`;
    case "degrees":
      return `a que graus estrangeiros se aplica ${topic}`;
    case "where":
      return `onde solicitar ${topic}`;
    case "documents":
      return `que documentos entregar para ${topic}`;
    case "cost":
      return `quanto custa ${topic}`;
    case "time":
      return `quanto tempo demora ${topic}`;
    default:
      return null;
  }
}

function cosineSimilarity(vecA, vecB) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const len = Math.min(vecA.length, vecB.length);

  for (let i = 0; i < len; i++) {
    const a = Number(vecA[i] ?? 0);
    const b = Number(vecB[i] ?? 0);
    dot += a * b;
    normA += a * a;
    normB += b * b;
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (!denom) return 0;
  return dot / denom;
}

async function loadAllChunks() {
  const files = fs
    .readdirSync(indexFolder)
    .filter((f) => f.endsWith(".ndjson") || f.endsWith(".json"));

  const chunks = [];

  for (const file of files) {
    const fullPath = path.join(indexFolder, file);

    if (file.endsWith(".ndjson")) {
      const rl = readline.createInterface({
        input: fs.createReadStream(fullPath, { encoding: "utf-8" }),
        crlfDelay: Infinity,
      });

      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
          const obj = JSON.parse(trimmed);
          if (!obj?.text || !Array.isArray(obj?.embedding)) continue;

          const embedding = obj.embedding.map(Number);
          chunks.push({ ...obj, embedding, file });
        } catch {
          // ignore
        }
      }
    } else {
      try {
        const data = JSON.parse(fs.readFileSync(fullPath, "utf-8"));
        if (!Array.isArray(data)) continue;

        for (const obj of data) {
          if (!obj?.text || !Array.isArray(obj?.embedding)) continue;

          const embedding = obj.embedding.map(Number);
          chunks.push({ ...obj, embedding, file });
        }
      } catch {
        // ignore
      }
    }
  }

  return chunks;
}

// Normalização para validar “literal” em PDFs/OCR
function normalizeForMatch(s) {
  return String(s === undefined || s === null ? "" : s)
    .normalize("NFKC")
    .replace(/-\s*\n\s*/g, "") // hifenização com quebra de linha
    .replace(/\r\n/g, "\n")
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[“”]/g, '"')
    .replace(/[‐‑‒–—]/g, "-")
    .trim();
}

function stripDiacriticsLower(s) {
  const norm = normalizeForMatch(s).toLowerCase();
  return norm.normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

function safeJsonParse(maybeJson) {
  try {
    return JSON.parse(maybeJson);
  } catch {
    return null;
  }
}

// JSON extraction robusto (chavetas balanceadas)
function extractFirstJsonObject(text) {
  const s = String(text ?? "");
  const start = s.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

function originOfChunk(c) {
  return c.relativePath ? `${c.category ?? "?"}/${c.relativePath}` : c.file ?? "?";
}

// ───────── Intenção “definição” ─────────
function extractSubjectForDefinition(lower) {
  const s = String(lower ?? "").trim();

  let m = s.match(/^o que (é|e)\s+(.+?)(\?+)?$/i);
  if (m) {
    let subj = String(m[2] ?? "").replace(/\?+$/g, "").trim();
    subj = subj.replace(/^(o|a|os|as)\s+/i, "").trim();
    return subj.length >= 4 ? subj : null;
  }

  m = s.match(/^defini(?:ç|c)ão de\s+(.+?)(\?+)?$/i);
  if (m) {
    const subj = String(m[1] ?? "").replace(/\?+$/g, "").trim();
    return subj.length >= 4 ? subj : null;
  }

  m = s.match(/^define\s+(.+?)(\?+)?$/i);
  if (m) {
    const subj = String(m[1] ?? "").replace(/\?+$/g, "").trim();
    return subj.length >= 4 ? subj : null;
  }

  m = s.match(/^o que significa\s+(.+?)(\?+)?$/i);
  if (m) {
    const subj = String(m[1] ?? "").replace(/\?+$/g, "").trim();
    return subj.length >= 4 ? subj : null;
  }

  return null;
}

// OCR-tolerante: scan TOTAL
function lexicalRescueBySubject(scored, subjectRaw, limit = 80) {
  const subj = stripDiacriticsLower(subjectRaw);
  if (subj.length < 4) return null;

  const key = subj.split(/\s+/).slice(0, 4).join(" ").trim();

  const hits = [];
  for (const c of scored) {
    const t = stripDiacriticsLower(c.text ?? "");
    if (t.includes(subj) || (key.length >= 4 && t.includes(key))) {
      hits.push({ ...c, score: (c.score ?? 0) + 2.0 });
    }
  }

  if (hits.length === 0) return null;
  hits.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return hits.slice(0, limit);
}

// ───────── FUNÇÃO PARA EXTRAIR LINKS DOS CHUNKS ─────────
function extractLinksFromChunks(scored, limit = 5, opts = {}) {
  console.log(
    "🔗 DEBUG extractLinksFromChunks: Analisando",
    Math.min(scored.length, limit),
    "chunks"
  );

  const { allowedOrigins = null } = opts; // Set([...]) ou null
  const links = [];
  const urlPattern = /(https?:\/\/[^\s)]+|www\.[^\s)]+)/gi;

  for (let i = 0; i < Math.min(scored.length, limit); i++) {
    const c = scored[i];
    const origin = originOfChunk(c);

    if (allowedOrigins && !allowedOrigins.has(origin)) {
      console.log(`🔗 DEBUG: Chunk ${i} ignorado (origem não permitida):`, origin);
      continue;
    }

    // 1) Preferir URLs vindas da ingestão (hiperligações reais do PDF)
    const metaUrlsRaw = c?.meta?.urls;
    const metaUrls = Array.isArray(metaUrlsRaw) ? metaUrlsRaw.filter(Boolean) : [];

    if (metaUrls.length > 0) {
      // Normalizar (www -> http://) e remover duplicados
      const normalizedMetaUrls = [
        ...new Set(
          metaUrls.map(url => (String(url).startsWith("www.") ? "http://" + url : String(url)))
        )
      ];

      console.log(`🔗 DEBUG: Chunk ${i} URLs em meta.urls:`, normalizedMetaUrls);

      links.push({
        source: origin,
        urls: normalizedMetaUrls
      });

      // Se já temos URLs explícitas do PDF, não vale a pena tentar regex no texto
      continue;
    }

    // 2) Fallback: procurar URLs no texto
    const text = c.text ?? "";
    console.log(`🔗 DEBUG: Chunk ${i} texto (primeiros 100 chars):`, text.substring(0, 100));

    const matches = text.match(urlPattern);

    if (matches) {
      console.log(`🔗 DEBUG: Chunk ${i} tem matches:`, matches);

      const normalizedUrls = [
        ...new Set(matches.map(url => (url.startsWith("www.") ? "http://" + url : url)))
      ];

      links.push({
        source: origin,
        urls: normalizedUrls
      });
    } else {
      console.log(`🔗 DEBUG: Chunk ${i} não tem URLs`);
    }
  }

  console.log("🔗 DEBUG: Total de conjuntos de links encontrados =", links.length);
  return links;
}

// ───────── FUNÇÃO PARA EXTRAIR LINKS ESPECÍFICOS POR TÓPICO ─────────
function extractTopicLinks(lower, scored) {
  console.log("🔗 DEBUG extractTopicLinks: Iniciando...");

  const topOrigin = scored?.[0] ? originOfChunk(scored[0]) : null;
  if (!topOrigin) return [];

  // Só links do mesmo PDF/origem do chunk mais relevante
  const linkSets = extractLinksFromChunks(scored, 10, { allowedOrigins: new Set([topOrigin]) });
  console.log("🔗 DEBUG: links brutos encontrados =", linkSets);

  const urls = linkSets.flatMap(ls => ls.urls || []);
  const uniqueLinks = [...new Set(urls)].slice(0, 3);
  console.log("🔗 DEBUG: topOrigin =", topOrigin);
  console.log("🔗 DEBUG: Links únicos relevantes =", uniqueLinks);

  return uniqueLinks;
}

// ───────── FUNÇÃO PARA ENRIQUECER RESPOSTA COM LINKS ─────────
function enrichAnswerWithLinks(answer, lower, scored) {
  console.log("🔗 DEBUG enrichAnswerWithLinks: Iniciando...");
  console.log("🔗 DEBUG: lower =", lower);
  console.log("🔗 DEBUG: scored tem", scored?.length, "chunks");

  const links = extractTopicLinks(lower, scored);
  console.log("🔗 DEBUG: links encontrados =", links);
  console.log("🔗 DEBUG: número de links =", links.length);

  if (links.length === 0) {
    console.log("🔗 DEBUG: Nenhum link encontrado, retornando resposta original");
    return answer;
  }

  // Evitar duplicar links
  if (answer.includes("🔗") || answer.includes("](") || answer.includes("http") || answer.includes("www.")) {
    console.log("🔗 DEBUG: Resposta já tem links, não adicionando mais");
    return answer;
  }

  let enrichedAnswer = answer;
  enrichedAnswer += "\n\n🔗 **Links relacionados:**";

  links.slice(0, 3).forEach((url, index) => {
    const label = index === 0 ? "Para mais informações, clique aqui" : `Link relacionado ${index + 1}`;
    enrichedAnswer += `\n• [${label}](${url})`;
  });

  console.log("🔗 DEBUG: Resposta enriquecida (primeiros 200 chars):", enrichedAnswer.substring(0, 200));
  return enrichedAnswer;
}

function pickFirstMatching(links, needles) {
  const ns = needles.map(s => s.toLowerCase());
  return links.find(u => ns.some(n => String(u).toLowerCase().includes(n))) || null;
}

function enrichAnswerInlineLinks(answer, lower, scored) {
  const links = extractTopicLinks(lower, scored);
  if (!links.length) return answer;

  // evita duplicar
  if (answer.includes("](") || answer.includes("http") || answer.includes("www.")) return answer;

  // escolhe links “principais”
  const formUrl =
    pickFirstMatching(links, ["dges.gov.pt/recon/formulario", "recon/formulario", "dges.gov.pt"]);
  const dlUrl =
    pickFirstMatching(links, ["dre.pt/application/conteudo/116068880", "dre.pt"]);

  let out = answer;

  // Mete o formulário no corpo da resposta, naturalmente
  if (formUrl) {
    out += ` Pode submeter o pedido através do formulário online: [clique aqui](${formUrl}).`;
  }

  // Opcional: referência ao DL no corpo (só se fizer sentido para ti)
  if (dlUrl) {
    out += ` Enquadramento legal: [ver Decreto‑Lei](${dlUrl}).`;
  }

  return out;
}

// ───────── filtros de qualidade (evitar TOC/índices) ─────────
function looksLikeIndexOrToc(text) {
  const t = stripDiacriticsLower(text);

  const artigoCount = (t.match(/\bartigo\b/g) ?? []).length;
  if (artigoCount >= 6) return true;

  if (t.includes("indice") && (t.includes("titulo") || t.includes("capitulo") || t.includes("secao")))
    return true;

  const numDot = (t.match(/\b\d+\.\s/g) ?? []).length;
  const artigoNum = (t.match(/\bartigo\s+\d+/g) ?? []).length;
  if (numDot + artigoNum >= 10) return true;

  return false;
}

function looksLikeHeadingLine(s) {
  const raw = String(s ?? "").trim();
  const t = stripDiacriticsLower(raw);

  if (t.length < 40) return true;

  const hasDefVerb = /\b(é|são|sao|consiste|designa|define|entende-?se)\b/.test(t);
  if (!/[.!?]$/.test(raw) && !hasDefVerb) return true;

  const upperRuns = (raw.match(/\b[A-ZÁÀÂãÉÊÍÓÔÕÚÇ]{3,}\b/g) ?? []).length;
  if (upperRuns >= 3) return true;

  return false;
}

// ───────── split de frases (PDF/OCR-friendly) ─────────
function splitSentences(text) {
  const t = normalizeForMatch(text)
    // cola hifenizações internas típicas de PDF/OCR: "pri- vado" -> "privado"
    .replace(/\b(\p{L}+)-\s+(\p{L}+)\b/gu, "$1$2");

  return t
    .split(
      /(?<=[.!?])\s+|\s{2,}|\s+(?=Artigo\s+\d+\.?º)|\s+(?=CAP[ÍI]TULO\b)|\s+(?=SEC[ÇC][ÃA]O\b)/g
    )
    .map((s) => s.trim())
    .filter((s) => s.length >= 25);
}

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ───────── fuzzy match para "regime de direito privado" ─────────
function mentionsRegimeDireitoPrivado(text) {
  const t = stripDiacriticsLower(text);
  // Padrão mais tolerante para hífens de OCR: "direito pri[-\s]*vado"
  return /regime\s+(de|do)\s+direito\s+pri[-\s]*vado/.test(t);
}

function startsWithSubjectRepeat(line, subject) {
  const l = stripDiacriticsLower(line);
  const s = stripDiacriticsLower(subject);
  if (!s) return false;

  if (l.startsWith(`${s} ${s}`)) return true;
  if (l.startsWith(`${s}  ${s}`)) return true;
  if (l.startsWith(`${s}: ${s}`)) return true;
  if (l.startsWith(`${s} - ${s}`)) return true;

  return false;
}

function findBestSentenceInChunkByPredicate(chunkText, predicateFn) {
  const sentences = splitSentences(chunkText ?? "");
  for (const s of sentences) {
    if (looksLikeHeadingLine(s)) continue;
    if (predicateFn(s)) return s;
  }
  return null;
}

function findWindowAroundMatch(rawText, regex, { window = 360 } = {}) {
  const text = normalizeForMatch(rawText);
  const m = text.match(regex);
  if (!m || m.index == null) return null;

  // 1) Janela bruta maior (para termos margem para âncoras)
  const roughStart = Math.max(0, m.index - 500);
  const roughEnd = Math.min(text.length, m.index + m[0].length + 500);
  const rough = text.slice(roughStart, roughEnd);

  // posição do match dentro da rough window
  const localIdx = m.index - roughStart;

  // 2) Tentar ancorar o início na entidade (evita começar a meio: "de Nova de Lisboa...")
  // Preferências: "A Universidade Nova de Lisboa" > "A Universidade" > "Universidade"
  const anchors = [
    /a\s+universidade\s+nova\s+de\s+lisboa/iu,
    /a\s+universidade\s+nova\s+de\s+lisboa/iu, // redundante mas inofensivo
    /a\s+universidade/iu,
    /universidade\s+nova\s+de\s+lisboa/iu,
    /universidade/iu,
  ];

  let startLocal = Math.max(0, localIdx - 120); // fallback
  for (const re of anchors) {
    // procurar a última ocorrência do anchor antes do match (ou muito perto)
    const left = rough.slice(0, localIdx + 20);
    let last = null;
    for (const mm of left.matchAll(re)) last = mm;
    if (last && last.index != null) {
      startLocal = last.index;
      break;
    }
  }

  // 3) Cortar o fim: termina na pontuação ou antes de "Artigo/CAPÍTULO/SECÇÃO"
  const right = rough.slice(startLocal);

  const cutMarkers = [
    /(\.\s)/,                 // fim de frase
    /(;+\s)/,                 // ponto e vírgula
    /(:\s)/,                  // dois pontos (muitas vezes antes de lista)
    /(\sArtigo\s+\d+)/i,
    /(\sCAP[ÍI]TULO\b)/i,
    /(\sSEC[ÇC][ÃA]O\b)/i,
  ];

  let endLocal = Math.min(right.length, window);
  for (const re of cutMarkers) {
    const mm = right.slice(0, Math.min(right.length, window + 120)).match(re);
    if (mm && mm.index != null && mm.index >= 30) { // não cortar cedo demais
      endLocal = Math.min(endLocal, mm.index + (mm[0].startsWith(".") ? 1 : 0));
      break;
    }
  }

  let snippet = right.slice(0, endLocal).trim();

  // 4) Limpeza OCR/hifenização e espaços
  snippet = snippet
    .replace(/\b(\p{L}+)-\s+(\p{L}+)\b/gu, "$1$2") // "ju- rídico" -> "jurídico"
    .replace(/\s+/g, " ")
    .trim();

  // Garantir que não começa com "de " solto (caso extremo)
  snippet = snippet.replace(/^de\s+/i, "");

  return snippet.length >= 50 ? snippet : null;
}

// ───────── PATCH: atalho determinístico inteligente para fundação/regime ─────────
function isGenericRJIESRegimeSentence(sn) {
  // sn deve vir normalizado (stripDiacriticsLower)
  return (
    sn.includes("nao prejudica a aplicacao") ||
    sn.includes("principios constitucionais") ||
    sn.includes("administracao publica")
  );
}

function mentionsNovaUnl(sn) {
  // sn deve vir normalizado (stripDiacriticsLower)
  return sn.includes("nova") || sn.includes("universidade") || sn.includes("unl");
}

function looksLikeFoundationSentence(sn) {
  // sn deve vir normalizado (stripDiacriticsLower)
  return (
    sn.includes(" e uma fundacao") ||
    sn.includes(" é uma fundacao") ||
    (sn.includes(" institui") && sn.includes("fundacao")) ||
    sn.includes("instituicao fundacao") ||
    sn.includes("fundacao publica") ||
    sn.includes("fundacao pública")
  );
}

function deterministicFoundationShortcut(scored, { topN = FOUNDATION_SHORTCUT_TOP_N, twoSentences = true } = {}) {
  const expanded = scored.slice(0, topN);

  const strong = [];
  const medium = [];
  const weak = [];

  let bestFoundation = null; // { chunk, sentence }
  let bestRegime = null; // { chunk, sentence }
  let bestFallbackGeneric = null; // { chunk, sentence }

  const better = (cur, cand) => {
    if (!cur) return cand;
    return (cand.chunk?.score ?? 0) > (cur.chunk?.score ?? 0) ? cand : cur;
  };

  for (const c of expanded) {
    const text = c.text ?? "";
    const tn = stripDiacriticsLower(text);

    if (!tn.includes("fundacao") && !mentionsRegimeDireitoPrivado(text)) continue;

    const sentences = splitSentences(text);

    for (const s of sentences) {
      if (!s) continue;
      if (looksLikeHeadingLine(s)) continue;

      const sn = stripDiacriticsLower(s);

      const hasRegime = mentionsRegimeDireitoPrivado(s);
      const hasFundacao = sn.includes("fundacao");
      const hasNova = mentionsNovaUnl(sn);

      if (hasRegime && isGenericRJIESRegimeSentence(sn)) {
        bestFallbackGeneric = better(bestFallbackGeneric, { chunk: c, sentence: s });
        weak.push({ chunk: c, sentence: s, generic: true });
        continue;
      }

      if (hasNova && hasFundacao && hasRegime) strong.push({ chunk: c, sentence: s });
      else if ((hasNova && hasRegime) || (hasFundacao && hasRegime)) medium.push({ chunk: c, sentence: s });
      else if (hasRegime) weak.push({ chunk: c, sentence: s });

      if (hasFundacao && looksLikeFoundationSentence(sn)) {
        if (hasNova) bestFoundation = better(bestFoundation, { chunk: c, sentence: s });
        else if (!bestFoundation) bestFoundation = better(bestFoundation, { chunk: c, sentence: s });
      }

      if (hasRegime) {
        if (hasNova) bestRegime = better(bestRegime, { chunk: c, sentence: s });
        else if (!bestRegime) bestRegime = better(bestRegime, { chunk: c, sentence: s });
      }
    }
  }

  const byChunkScoreDesc = (a, b) => (b.chunk?.score ?? 0) - (a.chunk?.score ?? 0);
  strong.sort(byChunkScoreDesc);
  medium.sort(byChunkScoreDesc);
  weak.sort(byChunkScoreDesc);

  if (twoSentences) {
    const parts = [];
    const citations = [];

    if (bestFoundation) {
      parts.push(bestFoundation.sentence.trim());
      citations.push({
        chunk: 0,
        quote: bestFoundation.sentence,
        source: originOfChunk(bestFoundation.chunk),
      });
    }

    if (bestRegime) {
      const sameAsFoundation =
        bestFoundation && stripDiacriticsLower(bestRegime.sentence) === stripDiacriticsLower(bestFoundation.sentence);

      if (!sameAsFoundation) {
        parts.push(bestRegime.sentence.trim());
        citations.push({
          chunk: citations.length,
          quote: bestRegime.sentence,
          source: originOfChunk(bestRegime.chunk),
        });
      }
    }

    if (parts.length === 0 && bestFallbackGeneric) {
      parts.push(bestFallbackGeneric.sentence.trim());
      citations.push({
        chunk: 0,
        quote: bestFallbackGeneric.sentence,
        source: originOfChunk(bestFallbackGeneric.chunk),
      });
    }

    if (parts.length > 0) {
      return { answer: parts.join(" "), citations };
    }
  }

  const pick = strong[0] ?? medium[0] ?? weak[0] ?? null;
  if (pick) {
    return {
      answer: pick.sentence,
      citations: [{ chunk: 0, quote: pick.sentence, source: originOfChunk(pick.chunk) }],
    };
  }

  return null;
}



// fallback determinístico só quando o LLM falha / JSON falha / citações falham
function foundationFallbackIfNeeded(lower, scored) {
  if (!stripDiacriticsLower(lower).includes("fundacao")) return null;

  const result = deterministicFoundationShortcut(scored, {
    topN: FOUNDATION_SHORTCUT_TOP_N,
    twoSentences: FOUNDATION_SHORTCUT_TWO_SENTENCES,
  });
      
  if (result) {
    console.log(`✅ Fallback determinístico ativado para fundação+regime`);
  }
      
  return result;
}

function buildContextFromSelected(selectedChunks) {
  const parts = [];
  const used = [];
  let total = 0;

  for (let i = 0; i < selectedChunks.length; i++) {
    const c = selectedChunks[i];
    const part = `[CHUNK ${parts.length}] SOURCE: ${originOfChunk(c)}\nTEXT:\n${c.text}`;

    if (total + part.length + 5 > MAX_CONTEXT_CHARS) {
      if (parts.length === 0) {
        parts.push(part.slice(0, MAX_CONTEXT_CHARS));
        used.push(c);
      }
      break;
    }

    parts.push(part);
    used.push(c);
    total += part.length + 5;
  }

  return { context: parts.join("\n\n---\n\n"), selectedChunks: used };
}

// ───────── construir contexto para um único chunk ─────────
// (tem de estar em top-level, não dentro de ifs/handlers)
function buildSingleChunkContext(chunk) {
  return buildContextFromSelected(chunk ? [chunk] : []);
}

// ───────── seleção de chunks por pergunta ─────────
function buildContextForQuestion(lower, scored) {
  const isFundacao = stripDiacriticsLower(lower).includes("fundacao");

  const isReconhecimentoAutomatico =
    lower.includes("reconhecimento") &&
    (lower.includes("automático") || lower.includes("automatico")) &&
    !lower.includes("nível") &&
    !lower.includes("nivel") &&
    !lower.includes("específico") &&
    !lower.includes("especifico");

  const isReconhecimentoAutomaticoComCusto =
    lower.includes("reconhecimento") &&
    (lower.includes("automático") || lower.includes("automatico")) &&
    (lower.includes("custa") || lower.includes("custo") || lower.includes("quanto")) &&
    !lower.includes("nível") &&
    !lower.includes("nivel");

  const isColegioDiretores =
    lower.includes("colégio de diretores") ||
    lower.includes("colegio de diretores") ||
    ((lower.includes("colégio") || lower.includes("colegio")) &&
      (lower.includes("diretores") ||
        lower.includes("directores") ||
        lower.includes("diretor") ||
        lower.includes("director")));

  const isReconhecimentoCusto =
    (lower.includes("reconhecimento") && lower.includes("academico")) &&
    (lower.includes("custa") || lower.includes("custo") || lower.includes("quanto"));

  const isReconhecimentoNivel =
    lower.includes("reconhecimento") &&
    (lower.includes("nível") || lower.includes("nivel")) &&
    (lower.includes("custa") || lower.includes("custo") || lower.includes("quanto"));

  const isLocationQuestion =
    (lower.includes("onde") || lower.includes("morada") || lower.includes("endereço") || lower.includes("endereco") ||
     lower.includes("sítio") || lower.includes("sitio") || lower.includes("local") ||
     lower.includes("contacto") || lower.includes("contato") || lower.includes("telefone") ||
     lower.includes("email") || lower.includes("campus") || lower.includes("sede")) &&
    !lower.includes("documentos"); // Não é localização se é sobre documentos

  const isDocumentsQuestion =
    lower.includes("documento") || 
    lower.includes("entregar") ||
    lower.includes("anexar") ||
    lower.includes("papel") ||
    lower.includes("diploma") ||
    lower.includes("histórico");

  let selectedChunks = [];

  console.log(`🏷️ TIPOS DETECTADOS: isFundacao=${isFundacao}, isReconhecimentoAutomatico=${isReconhecimentoAutomatico}, isReconhecimentoAutomaticoComCusto=${isReconhecimentoAutomaticoComCusto}, isReconhecimentoNivel=${isReconhecimentoNivel}, isReconhecimentoCusto=${isReconhecimentoCusto}, isLocationQuestion=${isLocationQuestion}, isDocumentsQuestion=${isDocumentsQuestion}`);

  if (isFundacao) {
    const expanded = scored.slice(0, 200);
    const filtered = expanded.filter((c) => {
      const hayRaw = `${c.text ?? ""} ${c.relativePath ?? ""} ${c.file ?? ""}`;
      const hay = stripDiacriticsLower(hayRaw);
      const hasFundacao = hay.includes("fundacao");
      const hasRegime = mentionsRegimeDireitoPrivado(hayRaw);

      if (hasFundacao && hasRegime) return true;
      if (hasFundacao || hasRegime) return true;
      return false;
    });

    const sorted = (filtered.length > 0 ? filtered : expanded)
      .slice()
      .sort((a, b) => {
        const aText = a.text ?? "";
        const bText = b.text ?? "";

        const aHas = mentionsRegimeDireitoPrivado(aText) ? 1 : 0;
        const bHas = mentionsRegimeDireitoPrivado(bText) ? 1 : 0;

        const aBestReg = findBestSentenceInChunkByPredicate(aText, (s) =>
          mentionsRegimeDireitoPrivado(s)
        );
        const bBestReg = findBestSentenceInChunkByPredicate(bText, (s) =>
          mentionsRegimeDireitoPrivado(s)
        );

        const aGeneric = aBestReg
          ? isGenericRJIESRegimeSentence(stripDiacriticsLower(aBestReg))
          : false;
        const bGeneric = bBestReg
          ? isGenericRJIESRegimeSentence(stripDiacriticsLower(bBestReg))
          : false;

        if (aHas !== bHas) return bHas - aHas;
        if (aGeneric !== bGeneric) return aGeneric ? 1 : -1;

        return (b.score ?? 0) - (a.score ?? 0);
      });

    selectedChunks = sorted.slice(0, 4);

  } else if (isReconhecimentoAutomaticoComCusto) {
    console.log("🔍 DETECTADO: Reconhecimento Automático + Custo");
    const expanded = scored.slice(0, 120);
    const filtered = expanded.filter((c) => {
      const t = stripDiacriticsLower(c.text ?? "");
      const isAutomatic = t.includes("automatico") || t.includes("automático");
      const hasMonetary = t.includes("€") || t.includes("euro") || t.includes("valor");
      const isNivel = t.includes("reconhecimento de nível") || t.includes("reconhecimento de nivel");
      return isAutomatic && hasMonetary && !isNivel;
    });

    console.log(`🔍 Filtrados por automático+custo: ${filtered.length} chunks`);

    selectedChunks = (filtered.length > 0 ? filtered : expanded.filter((c) => {
      const t = stripDiacriticsLower(c.text ?? "");
      return (t.includes("automatico") || t.includes("automático")) && !t.includes("reconhecimento de nível");
    })).slice(0, 5);

  } else if (isReconhecimentoAutomatico) {
    console.log("🔍 DETECTADO: Reconhecimento Automático");
    // Filtrar para apenas chunks de reconhecimento automático
    const expanded = scored.slice(0, 120);
    const filtered = expanded.filter((c) => {
      const t = stripDiacriticsLower(c.text ?? "");
      // Excluir "de nível" e "específico"
      const isAutomatic = t.includes("automatico") || t.includes("automático");
      const isNivel = t.includes("reconhecimento de nível") || t.includes("reconhecimento de nivel");
      const isEspecifico = t.includes("reconhecimento específico") || t.includes("reconhecimento especifico");
      
      return isAutomatic && !isNivel && !isEspecifico;
    });

    console.log(`🔍 Filtrados por automático: ${filtered.length} chunks`);

    selectedChunks = (filtered.length > 0 ? filtered : expanded.filter((c) => {
      const t = stripDiacriticsLower(c.text ?? "");
      return !t.includes("reconhecimento de nível") && 
             !t.includes("reconhecimento de nivel") &&
             !t.includes("reconhecimento específico") &&
             !t.includes("reconhecimento especifico");
    })).slice(0, 5);

  } else if (isDocumentsQuestion) {
    console.log("🔍 DETECTADO: Pergunta sobre Documentos");
    const expanded = scored.slice(0, 150);
    const filtered = expanded.filter((c) => {
      const t = stripDiacriticsLower(c.text ?? "");
      const docKeywords = [
        "documento", "cópia", "copia", "diploma", "histórico", "historico",
        "programa", "disciplina", "trabalho final", "dissertação", "dissertacao",
        "monografia", "tese", "anexar", "entregar", "apresentar"
      ];
      return docKeywords.some((kw) => t.includes(kw));
    });

    console.log(`🔍 Filtrados por documentos: ${filtered.length} chunks`);

    selectedChunks = (filtered.length > 0 ? filtered : expanded).slice(0, 5);

  } else if (isColegioDiretores) {
    const needles = ["colegio", "diretor", "director", "diretores", "directores"];
    const expanded = scored.slice(0, 180);
    const filtered = expanded.filter((c) => {
      const t = stripDiacriticsLower(c.text ?? "");
      const meta = stripDiacriticsLower(`${c.relativePath ?? ""} ${c.file ?? ""}`);

      const looksLikePlano = meta.includes("plano_estrategico") || meta.includes("plano estrategico");
      if (looksLikePlano) return false;

      const hasNeedle = needles.some((n) => t.includes(n));
      const isEstatutos = meta.includes("estatutos");
      return hasNeedle || isEstatutos;
    });

    selectedChunks = (filtered.length > 0 ? filtered : expanded).slice(0, 8);

  } else if (isReconhecimentoNivel) {
    const expanded = scored.slice(0, 150);
    const filtered = expanded.filter((c) => {
      const textLower = stripDiacriticsLower(c.text ?? "");

      const hasReconhecimentoNivel =
        (textLower.includes("reconhecimento") && textLower.includes("nível")) ||
        (textLower.includes("reconhecimento") && textLower.includes("nivel"));

      const hasMonetary =
        textLower.includes("€") ||
        textLower.includes("euro") ||
        textLower.includes("valor") ||
        textLower.includes("taxa") ||
        textLower.includes("custo");

      return hasReconhecimentoNivel && hasMonetary;
    });

    if (filtered.length === 0) {
      selectedChunks = expanded
        .filter((c) => {
          const textLower = stripDiacriticsLower(c.text ?? "");
          return (
            (textLower.includes("reconhecimento") && textLower.includes("nível")) ||
            (textLower.includes("reconhecimento") && textLower.includes("nivel"))
          );
        })
        .slice(0, 6);
    } else {
      selectedChunks = filtered.slice(0, 6);
    }

  } else if (isReconhecimentoCusto) {
    const expanded = scored.slice(0, 150);
    const filtered = expanded.filter((c) => {
      const hay = stripDiacriticsLower(`${c.text ?? ""} ${c.relativePath ?? ""} ${c.file ?? ""}`);
      const textLower = stripDiacriticsLower(c.text ?? "");

      const hasReconhecimento = hay.includes("reconhecimento");
      const hasMonetary =
        textLower.includes("€") ||
        textLower.includes("euro") ||
        textLower.includes("valor") ||
        textLower.includes("taxa") ||
        textLower.includes("custo");

      return hasReconhecimento && hasMonetary;
    });

    selectedChunks =
      filtered.length > 0
        ? filtered.slice(0, 6)
        : expanded
            .filter((c) => stripDiacriticsLower(c.text ?? "").includes("reconhecimento"))
            .slice(0, 6);

  } else if (isLocationQuestion) {
    const expanded = scored.slice(0, 100);
    const filtered = expanded.filter((c) => {
      const textLower = stripDiacriticsLower(c.text ?? "");
      const locationTerms = [
        "reitoria", "secretaria", "servicos academicos", "serviços académicos", "gabinete",
        "departamento", "campus", "endereco", "endereço", "morada", "telefone",
        "email", "contacto", "contato", "local", "sede", "escritorio", "escritório",
      ];
      return locationTerms.some((term) => textLower.includes(term));
    });

    selectedChunks = (filtered.length > 0 ? filtered : expanded).slice(0, 6);

  } else {
    selectedChunks = scored.slice(0, TOP_K);
  }

  // IMPORTANTE: devolve objeto { context, selectedChunks }
  return buildContextFromSelected(selectedChunks);
}

// ───────── fallback extractivo para definições ─────────
function extractiveDefinitionFallback(lower, selectedChunks) {
  const subject = extractSubjectForDefinition(lower);
  if (!subject) return null;

  const subj = subject.trim();
  const subjNorm = stripDiacriticsLower(subj);

  const reHasDefVerb = /\b(é|são|sao|consiste|designa|define|entende-?se)\b/i;
  const reSubject = new RegExp(`\\b${escapeRegExp(subjNorm)}\\b`, "i");
  const reStartsMid = /^\s*(e|é)\s+/i;
  const reStartsDef = /^\s*(entende-?se\s+por|consiste\s+em|designa\s+|define\s+)\b/i;

  for (let i = 0; i < selectedChunks.length; i++) {
    const sentences = splitSentences(selectedChunks[i].text);

    const hitA =
      sentences.find((s) => {
        if (looksLikeHeadingLine(s)) return false;
        if (startsWithSubjectRepeat(s, subj)) return false;

        const ss = stripDiacriticsLower(s);
        if (ss.length < 40 || ss.length > 360) return false;
        if (!reSubject.test(ss)) return false;
        if (!reHasDefVerb.test(ss)) return false;
        return true;
      }) ?? null;

    if (hitA) {
      return {
        answer: hitA,
        citations: [{ chunk: i, quote: hitA, source: originOfChunk(selectedChunks[i]) }],
      };
    }

    const hitB =
      sentences.find((s) => {
        if (looksLikeHeadingLine(s)) return false;
        if (startsWithSubjectRepeat(s, subj)) return false;

        const raw = String(s ?? "");
        const ss = stripDiacriticsLower(raw).trim();
        if (ss.length < 40 || ss.length > 360) return false;

        return reStartsMid.test(raw) || reStartsDef.test(ss);
      }) ?? null;

    if (hitB) {
      const cleaned = hitB.replace(/^\s*(e|é)\s+/i, "é ").trim();
      const answer = `${subj} ${cleaned}`.replace(/\s+/g, " ").trim();

      return {
        answer,
        citations: [{ chunk: i, quote: hitB, source: originOfChunk(selectedChunks[i]) }],
      };
    }
  }

  return null;
}



// ───────── fallback específico para custos/taxas ─────────
function costFallbackIfNeeded(lower, scored) {
  const isTimeQuestion =
    lower.includes("demora") ||
    lower.includes("tempo") ||
    lower.includes("prazo") ||
    lower.includes("dias") ||
    lower.includes("semanas") ||
    lower.includes("meses");

  // Evita confundir "quanto tempo" com custo.
  if (isTimeQuestion) {
    return timeFallbackIfNeeded(lower, scored);
  }

  const hasCostTerms = 
    lower.includes("custa") || 
    lower.includes("custo") || 
    lower.includes("preço") || 
    lower.includes("preco") || 
    lower.includes("taxa") || 
    lower.includes("valor") || 
    lower.includes("quanto");
    
  if (!hasCostTerms) return null;
  
  console.log("💰 PROCURANDO: Custos/taxas nos documentos");
  
  // Determinar qual tipo de reconhecimento é
  const isAutomatico = lower.includes("automático") || lower.includes("automatico");
  const isNivel = lower.includes("nível") || lower.includes("nivel");
  const isEspecifico = lower.includes("específico") || lower.includes("especifico");
  
  // Procurar explicitamente por valores monetários em TODOS os chunks
  const foundValues = [];
  const allSentences = [];
  
  for (const c of scored.slice(0, 100)) {
    const text = c.text ?? "";
    const textNorm = stripDiacriticsLower(text);
    
    // Procurar padrões de valores monetários
    const monetaryPatterns = [
      /\d+[.,]\d+\s*€/,
      /\d+\s*€/,
      /\d+[.,]\d+\s*euros?/i,
      /\d+\s*euros?/i,
      /valor[\s]*de[\s]*\d+[.,]?\d*/i,
      /taxa[\s]*de[\s]*\d+[.,]?\d*/i,
      /custo[\s]*de[\s]*\d+[.,]?\d*/i
    ];
    
    for (const pattern of monetaryPatterns) {
      const match = textNorm.match(pattern);
      if (match) {
        // Encontrar a frase completa que contém o valor
        const sentences = splitSentences(text);
        for (const sentence of sentences) {
          const sentenceNorm = stripDiacriticsLower(sentence);
          if (sentenceNorm.includes(match[0].toLowerCase())) {
            // VALIDAÇÃO: Não devolver texto truncado
            if (sentence.endsWith('...') || sentence.length < 20) continue;
            
            // FILTRAR: Excluir valores que claramente vêm de contexto diferente
            const sentenceLower = stripDiacriticsLower(sentence);
            
            // Se é para automático, evitar valores de nível ou específico
            if (isAutomatico) {
              const hasNivelIndicator = sentenceLower.includes("reconhecimento de nível") || 
                                       sentenceLower.includes("reconhecimento de nivel") ||
                                       sentenceLower.includes("nível") ||
                                       sentenceLower.includes("nivel");
              const hasEspecificoIndicator = sentenceLower.includes("reconhecimento específico") ||
                                            sentenceLower.includes("reconhecimento especifico");
              
              if (hasNivelIndicator || hasEspecificoIndicator) {
                console.log(`⚠️  IGNORANDO (contexto diferente): ${sentence.substring(0, 60)}...`);
                continue; // Ignorar este valor
              }
            }
            
            allSentences.push({ sentence, source: originOfChunk(c) });
            foundValues.push(match[0]);
            console.log(`✅ ENCONTREI custo: ${sentence.substring(0, 80)}...`);
          }
        }
      }
    }
  }
  
  if (allSentences.length === 0) {
    console.log("❌ NÃO ENCONTREI custos no contexto recuperado");
    return null;
  }
  
  // Se encontrou múltiplos valores, devolver combinado
  const uniqueValues = [...new Set(foundValues)];
  
  if (uniqueValues.length > 1) {
    const combinedAnswer = `Reconhecimento automático: ${uniqueValues.join(" ou ")}`;
    console.log(`✅ COMBINADO (${uniqueValues.length} valores): ${combinedAnswer}`);
    return {
      answer: combinedAnswer,
      citations: [{ chunk: 0, quote: allSentences[0].sentence, source: allSentences[0].source }],
    };
  }
  
  // Se só encontrou um valor, retornar
  return {
    answer: allSentences[0].sentence.trim(),
    citations: [{ chunk: 0, quote: allSentences[0].sentence, source: allSentences[0].source }],
  };
}

// ───────── fallback específico para tempo/prazos ─────────
function timeFallbackIfNeeded(lower, scored) {
  const isTimeQuestion =
    lower.includes("demora") ||
    lower.includes("tempo") ||
    lower.includes("prazo") ||
    lower.includes("dias") ||
    lower.includes("semanas") ||
    lower.includes("meses");
  
  if (!isTimeQuestion) return null;
  
  console.log("⏱️ PROCURANDO: Prazo/tempo nos documentos");
  
  // Procurar nos primeiros chunks por frases com linguagem de prazo
  for (const c of scored.slice(0, 80)) {
    const text = c.text ?? "";
    const sentences = splitSentences(text);

    const hit = sentences.find((s) => {
      const sn = stripDiacriticsLower(s);
      if (sn.length < 25) return false;

      const hasDurationPattern =
        /\b\d+\s*(dias|semanas|meses)\b/.test(sn) ||
        sn.includes("prazo") ||
        sn.includes("apos a instrucao completa") ||
        sn.includes("após a instrução completa") ||
        sn.includes("instrucao completa do processo") ||
        sn.includes("instrução completa do processo");

      const looksLikeOfficeHours =
        sn.includes("telefone") ||
        sn.includes("horario") ||
        sn.includes("horário") ||
        sn.includes("funcionamento") ||
        /\b\d{1,2}h\d{2}\b/.test(sn) ||
        sn.includes("contacto") ||
        sn.includes("contato") ||
        sn.includes("email");

      // para evitar apanhar custos
      const hasMoney = sn.includes("€") || sn.includes("euro") || sn.includes("euros");

      return hasDurationPattern && !looksLikeOfficeHours && !hasMoney;
    });
    
    if (hit) {
      // VALIDAÇÃO: Não devolver texto truncado
      if (hit.endsWith('...') || hit.length < 20) continue;
      
      console.log(`✅ ENCONTREI prazo: ${hit.slice(0, 90)}...`);
      return {
        answer: hit.trim(),
        citations: [{ chunk: 0, quote: hit, source: originOfChunk(c) }],
      };
    }
  }
  
  console.log("❌ NÃO ENCONTREI prazo/tempo no contexto recuperado");
  return null;
}

// ───────── fallback específico para alojamento ─────────
function housingFallbackIfNeeded(lower, scored) {
  const housingTerms = ["alojamento", "residencia", "hospedagem", "morada", "casa"];
  const hasHousingTerm = housingTerms.some(term => lower.includes(term));
    
  if (!hasHousingTerm) return null;

  const isHouseRequest =
    lower.includes("arranja-me uma casa") ||
    lower.includes("arranjar casa") ||
    lower.includes("procurar casa") ||
    lower.includes("casa");

  if (isHouseRequest) {
    return {
      answer:
        "Posso ajudar apenas com alojamento universitário (residências e apoio dos SASNOVA). Se quiser, indico como solicitar alojamento académico na NOVA.",
      citations: [],
    };
  }
    
  // Procurar chunks que mencionem alojamento
  for (const c of scored.slice(0, 50)) {
    const text = c.text ?? "";
    const textNorm = stripDiacriticsLower(text);
      
    if (textNorm.includes("alojamento") || textNorm.includes("residencia")) {
      // Tentar extrair uma frase relevante
      const sentences = splitSentences(text);
      const relevantSentence = sentences.find(s => {
        const sNorm = stripDiacriticsLower(s);
        return sNorm.includes("alojamento") || sNorm.includes("residencia");
      });
        
      if (relevantSentence) {
        return {
          answer: relevantSentence.trim(),
          citations: [{ chunk: 0, quote: relevantSentence, source: originOfChunk(c) }],
        };
      }
    }
  }
    
  return null;
}

function genericHousingIntroIfNeeded(lower) {
  const q = stripDiacriticsLower(lower).trim();

  const isGenericHousingPrompt =
    q === "alojamento" ||
    q === "alojamento universitario" ||
    q === "alojamento académico" ||
    q === "alojamento academico" ||
    q === "residencia" ||
    q === "residencias" ||
    q === "residencia universitaria" ||
    q === "residencias universitarias";

  if (!isGenericHousingPrompt) return null;

  return {
    answer:
      "Na NOVA, o alojamento para estudantes é assegurado sobretudo pelos SASNOVA, com especial foco nas residências universitárias. Atualmente, destacam-se a Residência Universitária do Lumiar, a Residência Universitária Fraústo da Silva, no Campus da Caparica, em Almada, e a Residência Universitária Alfredo de Sousa, em Campolide, que se encontra encerrada para obras. Se quiser, posso indicar como funcionam as candidaturas, que residências existem ou quais são os contactos do Gabinete de Alojamento.",
    citations: [],
  };
}

function housingLocationFallbackIfNeeded(lower, topicHint = "") {
  const qNorm = stripDiacriticsLower(lower);
  const topicNorm = stripDiacriticsLower(topicHint);

  const mentionsAcademicServices =
    qNorm.includes("servicos academicos") ||
    qNorm.includes("servico academico") ||
    qNorm.includes("uaa") ||
    qNorm.includes("unidade de assuntos academicos") ||
    qNorm.includes("assuntos academicos") ||
    qNorm.includes("reitoria") ||
    qNorm.includes("reconhecimento");

  const asksOfficeHours =
    qNorm.includes("horario") ||
    qNorm.includes("horarios") ||
    qNorm.includes("funcionamento") ||
    qNorm.includes("aberto") ||
    qNorm.includes("atendimento");

  const asksPhoneOrContact =
    qNorm.includes("telefone") ||
    qNorm.includes("telemovel") ||
    qNorm.includes("contacto") ||
    qNorm.includes("contato") ||
    qNorm.includes("contactos") ||
    qNorm.includes("contatos") ||
    qNorm.includes("email") ||
    qNorm.includes("e-mail");

  const asksAddressOrLocation =
    qNorm.includes("onde") ||
    qNorm.includes("morada") ||
    qNorm.includes("endereco") ||
    qNorm.includes("campus") ||
    qNorm.includes("local") ||
    qNorm.includes("sede") ||
    qNorm.includes("gabinete de alojamento");

  const isHousingOfficeQuery =
    qNorm.includes("alojamento") ||
    qNorm.includes("residencia") ||
    qNorm.includes("sasnova") ||
    qNorm.includes("gabinete de alojamento") ||
    topicNorm.includes("alojamento");

  if (mentionsAcademicServices) {
    return null;
  }

  if (!isHousingOfficeQuery || (!asksOfficeHours && !asksPhoneOrContact && !asksAddressOrLocation)) {
    return null;
  }

  if (asksOfficeHours) {
    return {
      answer:
        "Nos documentos carregados não encontrei um horário específico do Gabinete de Alojamento. Os contactos indicados são o telefone +351 213 715 600, o e-mail alojamento@unl.pt e a página dos SASNOVA: https://sas.unl.pt/alojamento/.",
      citations: [],
    };
  }

  return {
    answer:
      "Os contactos do Gabinete de Alojamento dos SASNOVA são: telefone +351 213 715 600, e-mail alojamento@unl.pt e página https://sas.unl.pt/alojamento/.",
    citations: [],
  };
}

/// ───────── fallback específico para LOCALIZAÇÃO de reconhecimento de nível ─────────
function nivelLocationFallbackIfNeeded(lower, scored) {
  // Verificar se é pergunta sobre ONDE solicitar reconhecimento de nível
  const isNivelLocationQuestion = 
    lower.includes("onde") && 
    lower.includes("reconhecimento") && 
    (lower.includes("nível") || lower.includes("nivel")) &&
    (lower.includes("solicitar") || lower.includes("pedir") || lower.includes("entregar") || lower.includes("apresentar"));
    
  if (!isNivelLocationQuestion) return null;
  
  console.log("📍 PROCURANDO: Localização para reconhecimento de nível");
  
  // Estratégia 1: Procurar por informações de contacto nos chunks
  for (const c of scored.slice(0, 30)) {
    const text = c.text ?? "";
    const textLower = text.toLowerCase();
    
    // Se o chunk menciona reconhecimento, extrair informação útil
    if (textLower.includes("reconhecimento")) {
      const sentences = splitSentences(text);
      
      // Procurar frases com informação institucional
      for (const sentence of sentences) {
        const sentenceLower = sentence.toLowerCase();
        
        // Termos que indicam localização institucional
        const locationIndicators = [
          "serviços académicos",
          "servicos academicos", 
          "reitoria",
          "secretaria",
          "gabinete",
          "departamento",
          "direção-geral",
          "direcao-geral",
          "dges",
          "ensino superior",
          "universidade",
          "faculdade",
          "instituição",
          "instituicao"
        ];
        
        for (const term of locationIndicators) {
          if (sentenceLower.includes(term) && sentence.length > 40) {
            // VALIDAÇÃO
            if (sentence.endsWith('...') || sentence.length < 50) continue;
            
            console.log(`✅ ENCONTREI informação institucional: ${sentence.substring(0, 100)}...`);
            return {
              answer: sentence.trim(),
              citations: [{ chunk: 0, quote: sentence, source: originOfChunk(c) }],
            };
          }
        }
      }
    }
  }
  
  // Estratégia 2: Resposta padrão baseada no conhecimento do sistema
  console.log("⚠️  Usando resposta padrão para localização de reconhecimento de nível");
  
  return {
    answer: getRecognitionTypeText("nivel", "where"),
    citations: []
  };
}

// ───────── fallback específico para reconhecimento de nível ─────────
function nivelRecognitionFallbackIfNeeded(lower, scored, variantScope = "") {
    const isNivelRecognition = 
        lower.includes("reconhecimento") && 
        (lower.includes("nível") || lower.includes("nivel")) &&
        (lower.includes("custa") || lower.includes("custo") || lower.includes("quanto"));
          
    if (!isNivelRecognition) return null;
          
    console.log("🔍 PROCURANDO: Valores para 'reconhecimento de nível'");
    
    // RESPOSTA FIXA - já que sabemos exatamente quais são os valores
    const fixedAnswer = getRecognitionTypeText("nivel", "cost", variantScope);

    // Encontrar qualquer chunk para a citação
    for (const c of scored.slice(0, 5)) {
        if (c.text && (c.text.includes("268,00 €") || c.text.includes("650,00 €"))) {
            return {
                answer: fixedAnswer,
                citations: [{ 
                    chunk: 0, 
                    quote: "Valores de reconhecimento de nível conforme tabela de emolumentos", 
                    source: originOfChunk(c) 
                }],
            };
        }
    }
    
    // Se não encontrou chunk específico, devolver mesmo assim
    return {
        answer: fixedAnswer,
        citations: [],
    };
}

// ───────── fallback específico para reconhecimento académico (VERSÃO SIMPLES) ─────────
function academicRecognitionFallbackIfNeeded(lower, scored, variantScope = "") {
  // Verificar se é pergunta sobre custos de reconhecimento académico
  const isAcademicRecognition = 
    lower.includes("reconhecimento") && 
    (lower.includes("academico") || lower.includes("académico")) &&
    (lower.includes("custa") || lower.includes("custo") || lower.includes("quanto"));
    
  if (!isAcademicRecognition) return null;
    
  console.log("🔍 PROCURANDO: Valores para 'reconhecimento académico' (40€/60€)");
  
  // Procurar nos primeiros chunks
  for (const c of scored.slice(0, 50)) {
    const text = c.text ?? "";
    
    // Procurar valores específicos do reconhecimento académico (automático)
    // 40€ / 60€
    const academicPatterns = [
      /40[\s]*€/,
      /60[\s]*€/
    ];
    
    for (const pattern of academicPatterns) {
      const match = text.match(pattern);
      if (match) {
        console.log(`✅ ENCONTREI: Valor ${match[0]} para reconhecimento académico`);
        
        // Verificar se está na secção de reconhecimento automático
        const textLower = text.toLowerCase();
        if (textLower.includes("reconhecimento") && 
            (textLower.includes("automático") || textLower.includes("automatico"))) {
          
          // Encontrar a linha completa com o valor
          const lines = text.split('\n');
          for (const line of lines) {
            if (line.includes(match[0]) && line.toLowerCase().includes("reconhecimento")) {
              return {
                answer: line.trim(),
                citations: [{ chunk: 0, quote: line, source: originOfChunk(c) }],
              };
            }
          }
        }
      }
    }
  }
  
  console.log("❌ NÃO ENCONTREI: Valores específicos para reconhecimento académico");
  return {
    answer: getRecognitionTypeText("automatico", "cost", variantScope),
    citations: [],
  };
}

// ───────── CHAMADA AO LLM ─────────
async function callOllamaJson(question, context, { timeoutMs, optionsOverride, answerSpec } = {}) {
  const url = `${OLLAMA_HOST}/api/generate`;

  const payload = {
    model: OLLAMA_MODEL,
    prompt: `Responda com base UNICAMENTE no contexto abaixo. Use apenas informações do contexto. Se a resposta não estiver no contexto, responda com: "${FALLBACK}"

CONTEXTO:
${context}

PERGUNTA: ${question}

RESPONDA EM JSON (sem markdown, sem prefixo):
{"answer": "resposta curta em português", "citations": [{"chunk": 0, "quote": "citação exata do contexto"}]}
`,
    stream: false,
    options: {
      num_predict: 220,
      num_ctx: 2048,
      temperature: 0.1, // Reduzir temperatura para menos criatividade
      stop: ["\n\n\n", "CONTEXTO EXCLUSIVO:", "INSTRUÇÕES ABSOLUTAS:"],
      ...(optionsOverride ?? {}),
    },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`Ollama HTTP ${resp.status} ${resp.statusText} ${text}`);
    }

    const data = await resp.json();
    return String(data.response ?? "").trim();
  } finally {
    clearTimeout(timer);
  }
}

// ───────── fallback específico para localização ─────────
function locationFallbackIfNeeded(lower, scored, topicHint = "", variantScope = "") {
  console.log("📍 locationFallbackIfNeeded ANALISANDO:", lower);

  const q = String(lower ?? "").toLowerCase().trim();
  const topicNorm = stripDiacriticsLower(topicHint);
  const qNorm = stripDiacriticsLower(q);

  const asksOfficeHours =
    qNorm.includes("horario") ||
    qNorm.includes("horarios") ||
    qNorm.includes("horario de funcionamento") ||
    qNorm.includes("funcionamento") ||
    qNorm.includes("aberto") ||
    qNorm.includes("atendimento");

  const asksPhoneOrContact =
    qNorm.includes("telefone") ||
    qNorm.includes("telemovel") ||
    qNorm.includes("contacto") ||
    qNorm.includes("contato") ||
    qNorm.includes("contactos") ||
    qNorm.includes("contatos");

  const asksAddressOrLocation =
    qNorm.includes("onde") ||
    qNorm.includes("morada") ||
    qNorm.includes("endereco") ||
    qNorm.includes("campus") ||
    qNorm.includes("localizacao") ||
    qNorm.includes("localizacao") ||
    qNorm.includes("local") ||
    qNorm.includes("sede");

  const mentionsAcademicServicesShorthand =
    (qNorm.includes("academicos") || qNorm.includes("academico")) &&
    !qNorm.includes("docente") &&
    !qNorm.includes("docentes") &&
    !qNorm.includes("professor") &&
    !qNorm.includes("professores");

  const isRecognitionOfficeQuery =
    qNorm.includes("reconhecimento") ||
    qNorm.includes("uaa") ||
    qNorm.includes("unidade de assuntos academicos") ||
    qNorm.includes("assuntos academicos") ||
    qNorm.includes("servicos academicos") ||
    mentionsAcademicServicesShorthand ||
    qNorm.includes("reitoria") ||
    topicNorm.includes("reconhecimento");

  const ambiguityNote = mentionsAcademicServicesShorthand
    ? "Assumi que se refere aos Serviços Académicos/UAA. "
    : "";

  const housingLocationFallback = housingLocationFallbackIfNeeded(lower, topicHint);
  if (housingLocationFallback) {
    console.log("✅ É pedido determinístico de contacto/localização de alojamento/SASNOVA");
    return housingLocationFallback;
  }

  if (isRecognitionOfficeQuery && (asksOfficeHours || asksPhoneOrContact || asksAddressOrLocation)) {
    console.log("✅ É pedido determinístico de contacto/localização/horário da UAA/Reitoria");

    if (asksOfficeHours) {
      return {
        answer:
            `${ambiguityNote}${getRecognitionContactText("uaa", "hoursAnswer", {}, variantScope)}`,
        citations: [],
      };
    }

    if (asksPhoneOrContact && !asksAddressOrLocation) {
      return {
        answer:
            `${ambiguityNote}${getRecognitionContactText("uaa", "contactAnswer", {}, variantScope)}`,
        citations: [],
      };
    }

    return {
      answer:
          `${ambiguityNote}${getRecognitionContactText("uaa", "locationAnswer", {}, variantScope)}`,
      citations: [],
    };
  }

  // Marcadores fortes de "localização/contacto"
  const hasWhereSignals =
    q.includes("onde") ||
    q.includes("morada") ||
    q.includes("endereço") || q.includes("endereco") ||
    q.includes("contacto") || q.includes("contato") ||
    q.includes("telefone") ||
    q.includes("telemóvel") || q.includes("telemovel") ||
    q.includes("email") || q.includes("e-mail") ||
    q.includes("campus") ||
    q.includes("sítio") || q.includes("sitio") ||
    q.includes("local") ||
    q.includes("sede");

  // Verbos que aparecem em perguntas de localização, mas NÃO bastam sozinhos
  const hasActionVerbs =
    q.includes("entregar") ||
    q.includes("apresentar") ||
    q.includes("submeter") ||
    q.includes("enviar") ||
    q.includes("dirigir") ||
    q.includes("solicitar") ||
    q.includes("pedir");

  /**
   * Regra principal:
   * - Só tratamos como "localização" quando há sinais claros de lugar/contacto.
   * - "entregar/apresentar/solicitar" por si só NÃO conta como localização
   *   (senão perguntas como "que documentos tenho de entregar?" disparam isto).
   */
  const hasLocationIntent = hasWhereSignals || (hasActionVerbs && q.includes("onde"));

  if (!hasLocationIntent) {
    console.log("📍 NÃO é intenção de localização");
    return null;
  }

  console.log("✅ É intenção de localização!");

  const isNivelRecognitionTopic =
    (q.includes("reconhecimento") && (q.includes("nível") || q.includes("nivel"))) ||
    (topicNorm.includes("reconhecimento") && topicNorm.includes("nivel"));

  // Para reconhecimento de nível + localização
  if (isNivelRecognitionTopic) {
    console.log("✅ É reconhecimento de nível + localização");

    const answer = getRecognitionTypeText("nivel", "where", variantScope);

    return {
      answer,
      citations: [],
    };
  }

  const isAutomaticRecognitionTopic =
    (q.includes("reconhecimento") && (q.includes("automático") || q.includes("automatico"))) ||
    (topicNorm.includes("reconhecimento") && topicNorm.includes("automatico"));

  if (isAutomaticRecognitionTopic) {
    console.log("✅ É reconhecimento automático + localização");
    return {
      answer: getRecognitionTypeText("automatico", "where", variantScope),
      citations: [],
    };
  }

  const isSpecificRecognitionTopic =
    (q.includes("reconhecimento") && q.includes("específico")) ||
    (q.includes("reconhecimento") && q.includes("especifico")) ||
    (topicNorm.includes("reconhecimento") && topicNorm.includes("especifico"));

  if (isSpecificRecognitionTopic) {
    console.log("✅ É reconhecimento específico + localização");
    return {
      answer: getRecognitionTypeText("especifico", "where", variantScope),
      citations: [],
    };
  }

  // Localização geral (sem tópico específico)
  console.log("📍 É localização geral");
  return {
    answer:
      "Para obter a localização ou contactos corretos, indique a que serviço/processo se refere (por exemplo, reconhecimento, candidatura, propinas, etc.) ou pergunte explicitamente “onde”/“qual a morada/contacto”.",
    citations: [],
  };
}

// ───────── fallback determinístico para reconhecimento automático ─────────
function automaticRecognitionFallbackIfNeeded(lower, topicHint = "", variantScope = "") {
  const q = stripDiacriticsLower(lower);
  const t = stripDiacriticsLower(topicHint);

  const isAutoTopic =
    (q.includes("reconhecimento") && q.includes("automatico")) ||
    (t.includes("reconhecimento") && t.includes("automatico"));

  if (!isAutoTopic) return null;

  const isDefinitionQuestion =
    q === "reconhecimento automatico" ||
    q === "reconhecimento automático" ||
    q.includes("o que e") ||
    q.includes("definicao") ||
    q.includes("define") ||
    q.includes("significa");

  const isDegreesQuestion =
    q.includes("graus") ||
    q.includes("aplica") ||
    q.includes("a que graus") ||
    q.includes("quais graus");

  const isWhereQuestion =
    q.includes("onde") ||
    q.includes("como solicitar") ||
    q.includes("onde solicitar") ||
    q.includes("formulario");

  const isDocumentsQuestion =
    q.includes("document") ||
    q.includes("entregar") ||
    q.includes("anexar") ||
    q.includes("diploma");

  const isCostQuestion =
    q.includes("custa") ||
    q.includes("custo") ||
    q.includes("quanto");

  const isTimeQuestion =
    q.includes("demora") ||
    q.includes("tempo") ||
    q.includes("prazo") ||
    q.includes("dias");

  if (isDefinitionQuestion) {
    return {
      answer: getRecognitionTypeText("automatico", "definition", variantScope),
      citations: [],
    };
  }

  if (isDegreesQuestion) {
    return {
      answer: getRecognitionTypeText("automatico", "degrees", variantScope),
      citations: [],
    };
  }

  if (isWhereQuestion) {
    return {
      answer: getRecognitionTypeText("automatico", "where", variantScope),
      citations: [],
    };
  }

  if (isDocumentsQuestion) {
    return {
      answer: getRecognitionTypeText("automatico", "documents", variantScope),
      citations: [],
    };
  }

  if (isTimeQuestion) {
    return {
      answer: getRecognitionTypeText("automatico", "time", variantScope),
      citations: [],
    };
  }

  if (isCostQuestion) {
    return {
      answer: getRecognitionTypeText("automatico", "cost", variantScope),
      citations: [],
    };
  }

  return null;
}

// ───────── fallback determinístico para reconhecimento de nível ─────────
function levelRecognitionDeterministicFallbackIfNeeded(lower, topicHint = "", variantScope = "") {
  const q = stripDiacriticsLower(lower);
  const t = stripDiacriticsLower(topicHint);

  const isLevelTopic =
    (q.includes("reconhecimento") && q.includes("nivel")) ||
    (t.includes("reconhecimento") && t.includes("nivel"));

  if (!isLevelTopic) return null;

  const isDefinitionQuestion =
    q === "reconhecimento de nivel" ||
    q === "reconhecimento nivel" ||
    q === "reconhecimento de nível" ||
    q === "reconhecimento nível" ||
    q.includes("o que e") ||
    q.includes("definicao") ||
    q.includes("define") ||
    q.includes("significa");

  const isWhereQuestion =
    q.includes("onde") ||
    q.includes("como solicitar") ||
    q.includes("onde solicitar") ||
    q.includes("formulario");

  const isDocumentsQuestion =
    q.includes("document") ||
    q.includes("entregar") ||
    q.includes("anexar") ||
    q.includes("diploma");

  const isTimeQuestion =
    q.includes("demora") ||
    q.includes("tempo") ||
    q.includes("prazo") ||
    q.includes("dias");

  const isCostQuestion =
    !isTimeQuestion &&
    (q.includes("custa") || q.includes("custo") || q.includes("quanto") || q.includes("valor"));

  if (isDefinitionQuestion) {
    return {
      answer: getRecognitionTypeText("nivel", "definition", variantScope),
      citations: [],
    };
  }

  if (isWhereQuestion) {
    return {
      answer: getRecognitionTypeText("nivel", "where", variantScope),
      citations: [],
    };
  }

  if (isDocumentsQuestion) {
    return {
      answer: getRecognitionTypeText("nivel", "documents", variantScope),
      citations: [],
    };
  }

  if (isCostQuestion) {
    return {
      answer: getRecognitionTypeText("nivel", "cost", variantScope),
      citations: [],
    };
  }

  if (isTimeQuestion) {
    return {
      answer: getRecognitionTypeText("nivel", "time", variantScope),
      citations: [],
    };
  }

  return null;
}

// ───────── fallback determinístico para reconhecimento específico ─────────
function specificRecognitionDeterministicFallbackIfNeeded(lower, topicHint = "", variantScope = "") {
  const q = stripDiacriticsLower(lower);
  const t = stripDiacriticsLower(topicHint);

  const isSpecificTopic =
    (q.includes("reconhecimento") && q.includes("especifico")) ||
    (t.includes("reconhecimento") && t.includes("especifico"));

  if (!isSpecificTopic) return null;

  const isDefinitionQuestion =
    q === "reconhecimento especifico" ||
    q === "reconhecimento específico" ||
    q.includes("o que e") ||
    q.includes("definicao") ||
    q.includes("define") ||
    q.includes("significa");

  const isWhereQuestion =
    q.includes("onde") ||
    q.includes("como solicitar") ||
    q.includes("onde solicitar") ||
    q.includes("formulario");

  const isDocumentsQuestion =
    q.includes("document") ||
    q.includes("entregar") ||
    q.includes("anexar") ||
    q.includes("diploma") ||
    q.includes("historico") ||
    q.includes("programa");

  const isTimeQuestion =
    q.includes("demora") ||
    q.includes("tempo") ||
    q.includes("prazo") ||
    q.includes("dias");

  const isCostQuestion =
    !isTimeQuestion &&
    (q.includes("custa") || q.includes("custo") || q.includes("quanto") || q.includes("valor"));

  if (isDefinitionQuestion) {
    return {
      answer: getRecognitionTypeText("especifico", "definition", variantScope),
      citations: [],
    };
  }

  if (isWhereQuestion) {
    return {
      answer: getRecognitionTypeText("especifico", "where", variantScope),
      citations: [],
    };
  }

  if (isDocumentsQuestion) {
    return {
      answer: getRecognitionTypeText("especifico", "documents", variantScope),
      citations: [],
    };
  }

  if (isCostQuestion) {
    return {
      answer: getRecognitionTypeText("especifico", "cost", variantScope),
      citations: [],
    };
  }

  if (isTimeQuestion) {
    return {
      answer: getRecognitionTypeText("especifico", "time", variantScope),
      citations: [],
    };
  }

  return null;
}

console.log("✅ Funções de links carregadas:");
console.log("- extractLinksFromChunks:", typeof extractLinksFromChunks);
console.log("- extractTopicLinks:", typeof extractTopicLinks);
console.log("- enrichAnswerWithLinks:", typeof enrichAnswerWithLinks);
console.log("- automaticRecognitionFallbackIfNeeded:", typeof automaticRecognitionFallbackIfNeeded);
console.log("- levelRecognitionDeterministicFallbackIfNeeded:", typeof levelRecognitionDeterministicFallbackIfNeeded);
console.log("- specificRecognitionDeterministicFallbackIfNeeded:", typeof specificRecognitionDeterministicFallbackIfNeeded);

function jsonFallback(extra = {}) {
  return {
    answer: FALLBACK,
    citations: [],
    ...extra,
  };
}

// ───────── BOOTSTRAP ─────────
async function bootstrap() {
  const app = express();
  app.use(cors());
  app.use(bodyParser.json());

  console.log("📦 A carregar chunks..."); 
  const chunks = await loadAllChunks(); 
  console.log(`📚 Total de chunks carregados: ${chunks.length}`);

  console.log("🧠 A carregar modelo de embeddings..."); 
  const embedderPromise = pipeline("feature-extraction", modelPath, { pooling: "mean", normalize: true, });
  await checkOllamaModelAvailability();

  app.post("/ask", async (req, res) => {
  try {
    const questionRaw = req.body?.question;
    const rawSessionId = typeof req.body?.sessionId === "string" ? req.body.sessionId.trim() : "";
    const sessionId = rawSessionId || null;
    const trackSession = Boolean(sessionId);
    const question = typeof questionRaw === "string" ? questionRaw.trim() : "";
    if (!question) return res.status(400).json({ error: "Question is required" });

    console.log("\n📩 Pergunta recebida:", question);
    const lower = question.toLowerCase();

   
    // Verificar se é uma pergunta de continuação
// ───────── Follow-up + tópico de sessão (CORRIGIDO) ─────────

// Padrões de perguntas elípticas típicas de continuação
const FOLLOWUP_PATTERNS = [
  /^e\b/i,
  /^e\s+(quanto|como|onde|quem|quais|qual)\b/i,

  // continuação sobre requisitos / escopo
  /^(que|quais)\s+(documentos|graus|requisitos)\b/i,
  /^(a\s+que|a\s+quais)\b/i,     // "a que graus..."
  /^(quais|qual)\b/i,            // "quais...", "qual..."
  /^(isso|isto)\b/i,             // "isso..." "isto..."

  // follow-up sobre tempo
  /\b(demora|tempo|prazo|dias|semanas|meses)\b/i,
];

const qTrim = lower.trim();
const previousTopicRaw = trackSession ? (sessionContext.get(sessionId) || "") : "";
const previousTopicNorm = stripDiacriticsLower(previousTopicRaw);
const inferredTopic = inferTopicFromQuestion(lower, previousTopicRaw);
const inferredTopicNorm = stripDiacriticsLower(inferredTopic || "");
const currentIntent = detectQuestionIntent(lower);
const previousIntent = trackSession ? (sessionLastIntent.get(sessionId) || "") : "";
const recognitionSubtypeShorthand = detectRecognitionSubtypeShorthand(qTrim);
const hasQualifiedSessionTopic =
  previousTopicNorm.includes("reconhecimento") ||
  previousTopicNorm.includes("alojamento") ||
  previousTopicNorm.includes("propina") ||
  previousTopicNorm.includes("candidatura") ||
  previousTopicNorm.includes("estatuto") ||
  previousTopicNorm.includes("fundacao") ||
  previousTopicNorm.includes("servicos academicos") ||
  previousTopicNorm.includes("universidade");

// follow-up se:
// - bate num padrão típico
// - OU é uma pergunta curta e já existe contexto na sessão
// - MAS NUNCA se tem termos específicos de custos ou documentos (perguntas autónomas)
const hasCostTerms = qTrim.includes("custa") || qTrim.includes("custo") || qTrim.includes("quanto");
const hasDocTerms = qTrim.includes("documento") || qTrim.includes("entregar");
const hasLocationTerms =
  qTrim.includes("onde") ||
  qTrim.includes("morada") ||
  qTrim.includes("endereço") ||
  qTrim.includes("endereco") ||
  qTrim.includes("contacto") ||
  qTrim.includes("contactos") ||
  qTrim.includes("contato") ||
  qTrim.includes("contatos") ||
  qTrim.includes("telefone") ||
  qTrim.includes("email") ||
  qTrim.includes("e-mail") ||
  qTrim.includes("reitoria") ||
  qTrim.includes("serviços académicos") ||
  qTrim.includes("servicos academicos") ||
  qTrim.includes("uaa");

// Perguntas curtas de custo sem tópico explícito devem herdar contexto da sessão.
const isGenericCostQuestion =
  hasCostTerms &&
  !qTrim.includes("reconhecimento") &&
  !qTrim.includes("propina") &&
  qTrim.length <= 30;

const isExplicitTopicSwitch =
  Boolean(inferredTopicNorm) &&
  Boolean(previousTopicNorm) &&
  inferredTopicNorm !== previousTopicNorm;

const isEllipticContinuation = /^e\b/i.test(qTrim);

const canCarryIntentAcrossTopicSwitch =
  trackSession &&
  isEllipticContinuation &&
  isExplicitTopicSwitch &&
  !currentIntent &&
  Boolean(previousIntent) &&
  previousTopicNorm.includes("reconhecimento") &&
  inferredTopicNorm.includes("reconhecimento");

const isRecognitionSubtypeOnlyFollowUp =
  hasQualifiedSessionTopic &&
  previousTopicNorm.includes("reconhecimento") &&
  Boolean(recognitionSubtypeShorthand);

const recognitionSubtypeOnlyIntent = isRecognitionSubtypeOnlyFollowUp
  ? previousIntent || "definition"
  : null;

const isFollowUp =
  !isExplicitTopicSwitch &&
  (FOLLOWUP_PATTERNS.some((re) => re.test(qTrim)) ||
   (hasQualifiedSessionTopic && qTrim.length <= 48)) &&
  !hasDocTerms &&
  !hasLocationTerms &&
  !(hasCostTerms && !(hasQualifiedSessionTopic && isGenericCostQuestion));

// usar tópico anterior quando é follow-up
let enhancedQuestion = question;
if (isFollowUp && hasQualifiedSessionTopic) {
  const previousTopic = sessionContext.get(sessionId);
  enhancedQuestion = `${previousTopic}. ${question}`;
  console.log(`🔄 Usando tópico anterior para follow-up: ${previousTopic}`);
}

let routedQuestion = enhancedQuestion;
let effectiveIntent = currentIntent;
const activeSessionTopic = trackSession ? (sessionContext.get(sessionId) || "") : "";
const inferredTopicIsGenericLocation = inferredTopicNorm.includes("localizacao");
const activeTopicForIntent =
  inferredTopic && !inferredTopicIsGenericLocation
    ? inferredTopic
    : activeSessionTopic;

if (canCarryIntentAcrossTopicSwitch) {
  const carryQuestion = buildIntentCarryQuestion(previousIntent, inferredTopic);
  if (carryQuestion) {
    routedQuestion = carryQuestion;
    effectiveIntent = previousIntent;
    console.log(`🔁 A herdar intenção anterior (${previousIntent}) para novo tópico: ${inferredTopic}`);
  }
} else if (trackSession && isEllipticContinuation && currentIntent && activeTopicForIntent) {
  const normalizedQuestion = buildIntentCarryQuestion(currentIntent, activeTopicForIntent);
  if (normalizedQuestion) {
    routedQuestion = normalizedQuestion;
    console.log(`🧭 Follow-up normalizado para intenção ${currentIntent}: ${normalizedQuestion}`);
  }
} else if (isRecognitionSubtypeOnlyFollowUp && inferredTopic) {
  const normalizedQuestion = buildIntentCarryQuestion(recognitionSubtypeOnlyIntent, inferredTopic) || inferredTopic;
  routedQuestion = normalizedQuestion;
  effectiveIntent = recognitionSubtypeOnlyIntent;
  console.log(`🧭 Subtipo de reconhecimento normalizado: ${normalizedQuestion}`);
}

// atualizar contexto da sessão
if (trackSession && inferredTopic) {
  const previousTopic = sessionContext.get(sessionId);
  const inferredNorm = stripDiacriticsLower(inferredTopic);
  const previousNorm = stripDiacriticsLower(previousTopic ?? "");
  const isGenericLocationTopic = inferredNorm.includes("localizacao");

  // Não substituir um tópico específico por "localização" genérico.
  if (isGenericLocationTopic && previousTopic && !previousNorm.includes("localizacao")) {
    // mantém tópico anterior
  } else {
    sessionContext.set(sessionId, inferredTopic);
  }
}

const topicHint = trackSession ? (sessionContext.get(sessionId) || "") : "";
const topicHintNorm = stripDiacriticsLower(topicHint);
const routedLower = routedQuestion.toLowerCase();
const lowerNorm = stripDiacriticsLower(routedLower);
const responseVariantScope = trackSession ? `session:${sessionId}` : `question:${lowerNorm}`;
const pendingState = trackSession ? (sessionPendingState.get(sessionId) || "") : "";
const isRecognitionExplainPrompt =
  lowerNorm === "explica entao" ||
  lowerNorm === "explica então" ||
  lowerNorm === "explica" ||
  lowerNorm === "entao explica" ||
  lowerNorm === "então explica" ||
  lowerNorm === "podes explicar" ||
  lowerNorm === "pode explicar";

if (trackSession && !(pendingState === "generic_recognition_explain" && isRecognitionExplainPrompt)) {
  sessionPendingState.delete(sessionId);
}

if (trackSession) {
  if (effectiveIntent) sessionLastIntent.set(sessionId, effectiveIntent);
  else if (!isEllipticContinuation) sessionLastIntent.delete(sessionId);
}

const cacheKey = buildResponseCacheKey(lowerNorm, topicHintNorm, responseVariantScope);

const sendJson = (statusCode, payload, { cacheable = true, pendingState: nextPendingState = null } = {}) => {
  if (trackSession) {
    if (nextPendingState) sessionPendingState.set(sessionId, nextPendingState);
    else sessionPendingState.delete(sessionId);
  }

  if (cacheable) setCachedResponse(cacheKey, statusCode, payload, nextPendingState);
  return res.status(statusCode).json(payload);
};

const cachedResponse = getCachedResponse(cacheKey);
if (cachedResponse) {
  console.log("⚡ Cache hit");
  if (trackSession) {
    if (cachedResponse.pendingState) sessionPendingState.set(sessionId, cachedResponse.pendingState);
    else sessionPendingState.delete(sessionId);
  }
  return res.status(cachedResponse.statusCode).json(cachedResponse.payload);
}

// mantém isto (usas mais abaixo para boosts)
const isTimeQuestion =
  lower.includes("demora") ||
  lower.includes("tempo") ||
  lower.includes("prazo") ||
  lower.includes("dias");

const isHousingIntent =
  lowerNorm.includes("alojamento") ||
  lowerNorm.includes("residencia") ||
  lowerNorm.includes("hospedagem") ||
  lowerNorm.includes("arranja me uma casa") ||
  lowerNorm.includes("arranjar casa") ||
  lowerNorm.includes("procurar casa");

const outOfDomainPatterns = [
  /capital\s+de\s+portugal/,
  /quanto\s+ficou\s+o\s+benfica/,
  /resultado\s+do\s+benfica/,
  /tempo\s+para\s+amanha/,
  /meteorologia|previsao\s+do\s+tempo/,
  /como\s+posso\s+tirar\s+boas\s+notas/,
  /o\s+que\s+e\s+o\s+jantar/,
];

const hasHardOutOfDomainSignal = outOfDomainPatterns.some((re) => re.test(lowerNorm));

const isDomain =
  isRecognitionSubtypeOnlyFollowUp ||
  isHousingIntent ||
  DOMAIN_KEYWORDS.some((k) => lower.includes(k)) ||
  lowerNorm.includes("reconhecimento") ||
  lowerNorm.includes("dges") ||
  lowerNorm.includes("universidade") ||
  lowerNorm.includes("faculdade") ||
  lowerNorm.includes("curso") ||
  lowerNorm.includes("propina") ||
  lowerNorm.includes("candidatura");

// Permitir follow-ups mesmo sem palavras-chave explícitas
if (hasHardOutOfDomainSignal || (!isDomain && !isFollowUp)) {
  console.log("❌ Bloqueado: fora do domínio institucional");
  return sendJson(403, {
      answer: OUT_OF_DOMAIN_MESSAGE,
      citations: [],
      blocked: true,
      reason: "out_of_domain",
    });
}

if (
  lowerNorm.includes("arranja me uma casa") ||
  lowerNorm.includes("arranjar casa") ||
  lowerNorm.includes("procurar casa")
) {
  return sendJson(200, {
    answer:
      "Posso ajudar apenas com alojamento universitário (residências e apoio dos SASNOVA). Se quiser, indico como solicitar alojamento académico na NOVA.",
    citations: [],
  });
}

const genericHousingIntro = genericHousingIntroIfNeeded(lower);
if (genericHousingIntro) {
  return sendJson(200, genericHousingIntro);
}

// ───────── RESPOSTAS DETERMINÍSTICAS ANTES DE EMBEDDINGS/LLM ─────────
const qNormRecon = lowerNorm;
const mentionsReconhecimento = qNormRecon.includes("reconhecimento");
const mentionsType =
  qNormRecon.includes("automatico") ||
  qNormRecon.includes("nivel") ||
  qNormRecon.includes("especifico");

const asksRecognitionValuesOverview =
  mentionsReconhecimento &&
  !mentionsType &&
  (qNormRecon.includes("valor") || qNormRecon.includes("valores") || qNormRecon.includes("custa") || qNormRecon.includes("custo") || qNormRecon.includes("quanto")) &&
  (qNormRecon.includes("tipos") || qNormRecon.includes("respetivos") || qNormRecon.includes("respectivos") || qNormRecon.includes("diferentes"));

const asksGeneralRecognitionOverview =
  mentionsReconhecimento &&
  !mentionsType &&
  (qNormRecon.includes("reconhecimento de graus") ||
    qNormRecon.includes("reconhecimento de diplomas") ||
    qNormRecon.includes("como funciona o reconhecimento") ||
    qNormRecon.includes("como funciona o reconhecimento de graus") ||
    qNormRecon.includes("o que e o reconhecimento em portugal"));

const topicHasType =
  topicHintNorm.includes("automatico") ||
  topicHintNorm.includes("nivel") ||
  topicHintNorm.includes("especifico");

const asksGenericRecognitionExplanationFollowUp =
  pendingState === "generic_recognition_explain" &&
  !mentionsType &&
  isRecognitionExplainPrompt;

if (asksRecognitionValuesOverview) {
  return sendJson(200, {
    answer: getRecognitionGeneralText("valuesOverview", responseVariantScope),
    citations: [],
  });
}

if (asksGeneralRecognitionOverview) {
  return sendJson(200, {
    answer: getRecognitionGeneralText("overview", responseVariantScope),
    citations: [],
  }, { pendingState: "generic_recognition_explain" });
}

if (asksGenericRecognitionExplanationFollowUp) {
  return sendJson(200, {
    answer: getRecognitionGeneralText("explainPrompt", responseVariantScope),
    citations: [],
  });
}

if (mentionsReconhecimento && !mentionsType && !topicHasType) {
  console.log("❓ CLARIFICAÇÃO: reconhecimento sem tipo especificado");
  return sendJson(200, {
    answer: getRecognitionGeneralText("clarifyTypePrompt", responseVariantScope),
    citations: [],
  });
}

if (
  qNormRecon.includes("emolumento") ||
  qNormRecon.includes("propina") ||
  qNormRecon.includes("propinas")
) {
  return sendJson(200, {
    answer: getRecognitionGeneralText("emolumentsPrompt", responseVariantScope),
    citations: [],
  });
}

const specificFallbackDeterministic = specificRecognitionDeterministicFallbackIfNeeded(routedLower, topicHintNorm, responseVariantScope);
if (specificFallbackDeterministic) {
  console.log("✅ DETETADO: Usando fallback determinístico de reconhecimento específico");
  return sendJson(200, specificFallbackDeterministic);
}

const levelFallbackDeterministic = levelRecognitionDeterministicFallbackIfNeeded(routedLower, topicHintNorm, responseVariantScope);
if (levelFallbackDeterministic) {
  console.log("✅ DETETADO: Usando fallback determinístico de reconhecimento de nível");
  return sendJson(200, levelFallbackDeterministic);
}

const automaticFallback = automaticRecognitionFallbackIfNeeded(routedLower, topicHintNorm, responseVariantScope);
if (automaticFallback) {
  console.log("✅ DETETADO: Usando fallback determinístico de reconhecimento automático");
  return sendJson(200, automaticFallback);
}

    const embedder = await embedderPromise;
    const candidateChunks = buildScopedChunkPool(chunks, lowerNorm, topicHintNorm);
    if (candidateChunks.length !== chunks.length) {
      console.log(`⚡ Prefiltro de chunks: ${candidateChunks.length}/${chunks.length}`);
    }
    const qEmbedding = Array.from((await embedder(routedQuestion)).data);

    let scored = candidateChunks
      .filter((c) => Array.isArray(c.embedding) && typeof c.text === "string")
      .map((c) => {
  const baseScore = cosineSimilarity(qEmbedding, c.embedding);
  
  // Filtrar chunks irrelevantes (alojamento, cantinas, etc) a menos que sejam explícitos
  const isOffTopic = (c.text || "").toLowerCase().match(/cantina|biblioteca|refeitório|residência|bolsa|erasmus/) && 
                      !lower.includes("alojamento") && !lower.includes("residencia") && !lower.includes("bolsa");
  if (isOffTopic && baseScore < 0.35) return { ...c, embedding: c.embedding, score: -1 };
  let boost = 0;

  const hayRaw = `${c.text ?? ""} ${c.relativePath ?? ""} ${c.file ?? ""}`;
  const hay = stripDiacriticsLower(hayRaw);


        // Boost leve para alojamento
        if (lower.includes("alojamento") || lower.includes("residencia") || lower.includes("hospedagem")) {
          if (hay.includes("alojamento")) boost += 0.12;
        }

        // Boost leve para reconhecimento académico
        if (lower.includes("reconhecimento") && (lower.includes("nível") || lower.includes("nivel"))) {
          const textLower = stripDiacriticsLower(c.text ?? "");
          const hasNivel = textLower.includes("nível") || textLower.includes("nivel");
          const hasReconhecimento = textLower.includes("reconhecimento");

          if (hasNivel && hasReconhecimento) {
            boost += 0.45; // Boost muito maior

            // Boost EXTRA se tiver valores específicos do reconhecimento de nível
            const hasNivelValues =
              textLower.includes("268") || textLower.includes("650") ||
              textLower.includes("520") || textLower.includes("298") ||
              textLower.includes("680") || textLower.includes("550");

            if (hasNivelValues) {
              boost += 0.30;
            }
          }
        }

        // Boost para "reconhecimento académico" geral
        if (lower.includes("reconhecimento") && (lower.includes("academico") || lower.includes("académico"))) {
          const textLower = stripDiacriticsLower(c.text ?? "");
          if (textLower.includes("reconhecimento") &&
            (textLower.includes("academico") || textLower.includes("académico"))) {
            boost += 0.30;
          }
        }

        // Boost leve para estágios
        if (lower.includes("estagio") || lower.includes("estágio") || lower.includes("erasmus")) {
          if (hay.includes("estagio") || hay.includes("estágio") || hay.includes("erasmus")) {
            boost += 0.10;
          }
        }

        // Boost para perguntas sobre custos/taxas/preços
        const isTimeQuestionLocal =
  lower.includes("demora") ||
  lower.includes("tempo") ||
  lower.includes("prazo") ||
  lower.includes("dias");

const hasCostTerms =
  !isTimeQuestionLocal && (
    lower.includes("custa") ||
    lower.includes("custo") ||
    lower.includes("preço") ||
    lower.includes("preco") ||
    lower.includes("taxa") ||
    lower.includes("valor") ||
    // "quanto" só conta como custo se NÃO for sobre tempo
    lower.includes("quanto")
  );

        if (hasCostTerms) {
          // Boost para documentos que mencionam valores monetários
          const textLower = stripDiacriticsLower(c.text ?? "");
          const hasMonetaryTerms =
            textLower.includes("€") ||
            textLower.includes("euro") ||
            textLower.includes("euros") ||
            textLower.includes("valor") ||
            textLower.includes("taxa") ||
            textLower.includes("custo") ||
            textLower.includes("pagamento");

          if (hasMonetaryTerms) boost += 0.25;

          // Boost extra para documentos específicos de taxas/processos
          const isTaxDocument =
            hay.includes("taxa") ||
            hay.includes("processo") ||
            hay.includes("pedido") ||
            hay.includes("reconhecimento");

          if (isTaxDocument) boost += 0.15;
        }

        // Boost para perguntas sobre "que documentos"
        const isDocumentsQuestion = lower.includes("documento") || lower.includes("entregar");
        if (isDocumentsQuestion) {
          const textLower = stripDiacriticsLower(c.text ?? "");
          const docKeywords = [
            "cópia", "copia", "diploma", "histórico", "historico", "programa",
            "disciplina", "trabalho final", "dissertação", "dissertacao",
            "monografia", "tese", "anexar", "entregar", "apresentar"
          ];
          const hasDocKeyword = docKeywords.some((kw) => textLower.includes(kw));
          if (hasDocKeyword) boost += 0.50; // Boost BASTANTE para documentos relevantes
        }

        if (lower.includes("objetivo") || lower.includes("objetivos")) {
          if (String(c.category ?? "").toLowerCase().includes("plano")) boost += 0.08;
        }
        if (lower.includes("estatuto") || lower.includes("estatutos")) {
          if (String(c.category ?? "").toLowerCase().includes("estatuto")) boost += 0.08;
        }

        if (stripDiacriticsLower(lower).includes("fundacao")) {
          if (hay.includes("fundacao")) boost += 0.08;
          if (mentionsRegimeDireitoPrivado(hayRaw)) boost += 0.18;
          if (hay.includes("instituicao_fundacao_unl")) boost += 0.12;
        }

        const isColegio = hay.includes("colegio") || hay.includes("diretor") || hay.includes("director");
        if (isColegio) {
          if (hay.includes("estatutos")) boost += 0.1;
          if (hay.includes("colegio")) boost += 0.22;
          if (hay.includes("diretor") || hay.includes("director")) boost += 0.18;
          if (hay.includes("colegio de diretores")) boost += 0.15;
        }

        const subj = extractSubjectForDefinition(lower);
        if (subj) {
          const subjNorm = stripDiacriticsLower(subj);
          if (hay.includes(subjNorm)) boost += 0.25;

          const textNorm = stripDiacriticsLower(c.text ?? "");
          const startsMidSentence = /^\s*(e|é)\s+/.test(textNorm);
          if (startsMidSentence && !textNorm.includes(subjNorm)) boost -= 0.1;
        }

        // Boost para perguntas sobre "onde" / localização
const isLocationQuestion = 
  lower.includes("onde") || 
  lower.includes("local") || 
  lower.includes("endereço") || 
  lower.includes("endereco") ||
  lower.includes("sítio") || 
  lower.includes("sitio") ||
  lower.includes("lugar") ||
  lower.includes("contacto") ||
  lower.includes("contato");

if (isLocationQuestion) {
  const textLower = stripDiacriticsLower(c.text ?? "");
  const locationTerms = [
    "reitoria",
    "secretaria",
    "servicos academicos",
    "serviços académicos",
    "gabinete",
    "departamento",
    "campus",
    "endereco",
    "endereço",
    "morada",
    "telefone",
    "email",
    "contacto",
    "contato",
    "local",
    "sede",
    "escritorio",
    "escritório"
  ];
  
  const hasLocationTerm = locationTerms.some(term => textLower.includes(term));
  
  // SÓ dar boost se NÃO for documento de alojamento
  const isAlojamentoDoc = c.relativePath?.includes("alojamento") || c.file?.includes("Alojamento");
  
  if (hasLocationTerm && !isAlojamentoDoc) {
    boost += 0.35;
    console.log(`📍 Boost de localização para chunk: ${originOfChunk(c)}`);
  }
  
  // Boost extra se mencionar "reconhecimento" também
  if (textLower.includes("reconhecimento") && hasLocationTerm && !isAlojamentoDoc) {
    boost += 0.25;
  }
}

        // Boost específico para "nível"
        if (lower.includes("nível") || lower.includes("nivel")) {
          if (hay.includes("nível") || hay.includes("nivel")) {
            boost += 0.15;

            // Boost extra se também mencionar "reconhecimento"
            if (hay.includes("reconhecimento")) {
              boost += 0.10;
            }
          }
        }
         // Boost direcionado: follow-up sobre tempo/prazo quando o tópico é "reconhecimento de nível"
  if (isTimeQuestion && topicHintNorm.includes("reconhecimento") && topicHintNorm.includes("nivel")) {
    const textLower = stripDiacriticsLower(c.text ?? "");

    if (textLower.includes("reconhecimento") && (textLower.includes("nivel") || textLower.includes("nível"))) {
      boost += 0.35;
    }

    if (
      textLower.includes("dias") ||
      textLower.includes("prazo") ||
      textLower.includes("uteis") ||
      textLower.includes("úteis")
    ) {
      boost += 0.15;
    }
  }

        return { ...c, score: baseScore + boost };
      })
      .sort((a, b) => b.score - a.score);

    scored = scored.filter((c) => !looksLikeIndexOrToc(c.text ?? ""));
    
    // ───────── FALLBACK OBRIGATÓRIO PARA LOCALIZAÇÃO ─────────
console.log("📍 VERIFICANDO: É pergunta de localização?");
const locationFallback = locationFallbackIfNeeded(lower, scored, topicHintNorm, responseVariantScope);
if (locationFallback) {
  console.log("✅ DETETADO: Usando fallback de localização obrigatório");

  return sendJson(200, locationFallback);
}

    const subject = extractSubjectForDefinition(lower);

    if (subject) {
      const subjNorm = stripDiacriticsLower(subject);
      const existsInDocs = chunks.some((c) => stripDiacriticsLower(c.text ?? "").includes(subjNorm));
      console.log(`🔎 subject="${subject}" existsInDocs=${existsInDocs}`);

      const topHasSubject = scored.slice(0, 12).some((c) => stripDiacriticsLower(c.text ?? "").includes(subjNorm));

      if (!topHasSubject) {
        const rescued = lexicalRescueBySubject(scored, subject, 80);
        if (rescued) {
          console.log(`🛟 Lexical rescue (definição) ativado para subject="${subject}"`);
          scored = rescued;
        }
      }
    }

    const topPreview = scored.slice(0, TOP_K);
    console.log("🔍 Top chunks:");
    topPreview.forEach((c) => {
      console.log(` - score ${c.score.toFixed(3)} | ${originOfChunk(c)} | ${String(c.text).slice(0, 70)}...`);
    });

    if (topPreview.length === 0) return sendJson(200, jsonFallback());

    const best = topPreview[0];
    if (best.score < MIN_SIMILARITY) {
      console.log(`❌ Bloqueado por baixa similaridade (best=${best.score.toFixed(3)})`);
      return sendJson(200, jsonFallback());
    }

    const isDefinition = Boolean(subject);
    const useSingleChunk = !isDefinition && best.score >= 0.45;

    const { context, selectedChunks } = useSingleChunk
      ? buildSingleChunkContext(best)
      : buildContextForQuestion(lower, scored);

    // ───────── answerSpec dinâmico (fundação+regime) ─────────
    const qNorm = stripDiacriticsLower(lower);
    const fundacaoRegime =
      qNorm.includes("fundacao") &&
      (qNorm.includes("regime") ||
        qNorm.includes("em que regime") ||
        qNorm.includes("qual o regime") ||
        qNorm.includes("que regime"));

    const answerSpec = fundacaoRegime
      ? "com exatamente 2 frases. A PRIMEIRA deve afirmar claramente que é uma fundação. A SEGUNDA deve indicar explicitamente que está sob o 'regime de direito privado'."
      : "com 2 a 4 frases";

    let raw = "";
    try {
      raw = await callOllamaJson(question, context, {
        timeoutMs: 180_000, // 3 minutos (muito mais generoso)
        answerSpec
      });
    } catch (err) {
      console.error("🔥 Ollama falhou (tentativa 1/2):", String(err?.message ?? err));
    }

    if (!raw) {
      const shortContext = context.slice(0, 1000); // Contexto mais curto
      try {
        raw = await callOllamaJson(question, shortContext, {
          timeoutMs: 120_000, // 2 minutos
          optionsOverride: {
            num_predict: 120, // Menos tokens
            temperature: 0.1  // Pouca variação
          },
          answerSpec,
        });
      } catch (err) {
        console.error("🔥 Ollama falhou (tentativa 2/2):", String(err?.message ?? err));

        // Tentar fallback específico para reconhecimento de nível primeiro
        const nivelFallback = nivelRecognitionFallbackIfNeeded(lower, scored, responseVariantScope);
        console.log(`🔍 nivelFallback result: ${nivelFallback ? 'FOUND' : 'NULL'}`);
        if (nivelFallback) {
          console.log(`📤 RETORNANDO: nivelFallback`);
          return sendJson(200, nivelFallback);
        }

        // Tentar fallback específico para reconhecimento académico
        const academicFallback = academicRecognitionFallbackIfNeeded(lower, scored, responseVariantScope);
        console.log(`🔍 academicFallback result: ${academicFallback ? 'FOUND' : 'NULL'}`);
        if (academicFallback) {
          console.log(`📤 RETORNANDO: academicFallback`);
          return sendJson(200, academicFallback);
        }

        // Tentar fallback específico para custos (genérico)
        const costFallback = costFallbackIfNeeded(lower, scored);
        console.log(`🔍 costFallback result: ${costFallback ? 'FOUND' : 'NULL'}`);
        if (costFallback) {
          console.log(`📤 RETORNANDO: costFallback`);
          return sendJson(200, costFallback);
        }

        // Tentar fallback específico para alojamento
        const housingFallback = housingFallbackIfNeeded(lower, scored);
        if (housingFallback) return sendJson(200, housingFallback);

        // Tentar fallback específico para localização
        const locationFallback = locationFallbackIfNeeded(lower, scored, topicHintNorm, responseVariantScope);
        if (locationFallback) return sendJson(200, locationFallback);

        const exDef = extractiveDefinitionFallback(lower, selectedChunks);
        if (exDef) return sendJson(200, exDef);

        const fast = foundationFallbackIfNeeded(lower, scored);
        if (fast) return sendJson(200, fast);

        return sendJson(200, jsonFallback());
      }
    }

    const jsonCandidate = extractFirstJsonObject(raw) ?? raw;
    const obj = safeJsonParse(jsonCandidate);

    if (!obj || typeof obj.answer !== "string" || !Array.isArray(obj.citations)) {
      console.log("❌ LLM não devolveu JSON válido -> fallback");

      // Tentar fallback específico para reconhecimento de nível primeiro
      const nivelFallback = nivelRecognitionFallbackIfNeeded(lower, scored, responseVariantScope);
      if (nivelFallback) return sendJson(200, nivelFallback);

      // Tentar fallback específico para reconhecimento académico
      const academicFallback = academicRecognitionFallbackIfNeeded(lower, scored, responseVariantScope);
      if (academicFallback) return sendJson(200, academicFallback);

      // Tentar fallback específico para custos (genérico)
      const costFallback = costFallbackIfNeeded(lower, scored);
      if (costFallback) return sendJson(200, costFallback);

      // Tentar fallback específico para alojamento
      const housingFallback = housingFallbackIfNeeded(lower, scored);
      if (housingFallback) return sendJson(200, housingFallback);

      // Tentar fallback específico para localização
      const locationFallback = locationFallbackIfNeeded(lower, scored, topicHintNorm, responseVariantScope);
      if (locationFallback) return sendJson(200, locationFallback);

      const exDef = extractiveDefinitionFallback(lower, selectedChunks);
      if (exDef) return sendJson(200, exDef);

      const fast = foundationFallbackIfNeeded(lower, scored);
      if (fast) return sendJson(200, fast);

      return sendJson(200, jsonFallback());
    }

    // ───────── VERIFICAÇÃO: Filtrar respostas incorretas sobre Associação de Estudantes ─────────
// preparar answerText ANTES de qualquer uso
const answerText = String(obj.answer ?? "").trim();
if (!answerText) return sendJson(200, jsonFallback());

// Guardrail: se o tópico é reconhecimento de nível, não aceitar respostas que só falem de reconhecimento académico
if (topicHintNorm.includes("reconhecimento") && topicHintNorm.includes("nivel")) {
  const aNorm = stripDiacriticsLower(answerText);

  const mentionsNivel = aNorm.includes("nivel") || aNorm.includes("nível");
  const mentionsAcad = aNorm.includes("reconhecimento academico") || aNorm.includes("reconhecimento académico");

  // Se menciona académico e não menciona nível, é muito provável que esteja a ir ao documento errado
  if (mentionsAcad && !mentionsNivel) {
    console.log("❌ Tópico é 'reconhecimento de nível' mas resposta fala só de 'reconhecimento académico' -> fallback");

    const locationFallback = locationFallbackIfNeeded(lower, scored, topicHintNorm, responseVariantScope);
    if (locationFallback) return sendJson(200, locationFallback);

    return sendJson(200, jsonFallback());
  }
}

// ───────── VERIFICAÇÃO: Filtrar respostas incorretas sobre Associação de Estudantes ─────────
if (answerText.includes("Associação de Estudantes") || answerText.includes("Associacao de Estudantes")) {
  console.log("❌ Resposta contém 'Associação de Estudantes' - não é local correto para reconhecimento");

  // Tentar fallback de localização
  const locationFallback = locationFallbackIfNeeded(lower, scored, topicHintNorm, responseVariantScope);
  if (locationFallback) return sendJson(200, locationFallback);

  // Se não encontrar, usar fallback genérico
  return sendJson(200, jsonFallback());
}

if (answerText === FALLBACK) {
  console.log("ℹ️ LLM devolveu fallback explícito (JSON)");

  const nivelFallback = nivelRecognitionFallbackIfNeeded(lower, scored, responseVariantScope);
  if (nivelFallback) return sendJson(200, nivelFallback);

  const academicFallback = academicRecognitionFallbackIfNeeded(lower, scored, responseVariantScope);
  if (academicFallback) return sendJson(200, academicFallback);

  const costFallback = costFallbackIfNeeded(lower, scored);
  if (costFallback) return sendJson(200, costFallback);

  const housingFallback = housingFallbackIfNeeded(lower, scored);
  if (housingFallback) return sendJson(200, housingFallback);

  const locationFallback = locationFallbackIfNeeded(lower, scored, topicHintNorm, responseVariantScope);
  if (locationFallback) return sendJson(200, locationFallback);

  const exDef = extractiveDefinitionFallback(lower, selectedChunks);
  if (exDef) return sendJson(200, exDef);

  const fast = foundationFallbackIfNeeded(lower, scored);
  if (fast) return sendJson(200, fast);

  return sendJson(200, jsonFallback());
}

    const citations = obj.citations
      .map((c) => {
        if (!c || typeof c !== "object") return null;
        const chunk = typeof c.chunk === "number" ? c.chunk : Number.parseInt(String(c.chunk), 10);
        const quote = typeof c.quote === "string" ? c.quote : "";
        if (!Number.isInteger(chunk)) return null;
        return { chunk, quote };
      })
      .filter(Boolean);

    if (citations.length === 0) {
      console.log("❌ JSON sem citações estruturadas -> fallback");

      // Tentar fallback específico para reconhecimento de nível primeiro
      const nivelFallback = nivelRecognitionFallbackIfNeeded(lower, scored, responseVariantScope);
      if (nivelFallback) return sendJson(200, nivelFallback);

      // Tentar fallback específico para reconhecimento académico
      const academicFallback = academicRecognitionFallbackIfNeeded(lower, scored, responseVariantScope);
      if (academicFallback) return sendJson(200, academicFallback);

      // Tentar fallback específico para custos (genérico)
      const costFallback = costFallbackIfNeeded(lower, scored);
      if (costFallback) return sendJson(200, costFallback);

      // Tentar fallback específico para alojamento
      const housingFallback = housingFallbackIfNeeded(lower, scored);
      if (housingFallback) return sendJson(200, housingFallback);

      // Tentar fallback específico para localização
      const locationFallback = locationFallbackIfNeeded(lower, scored, topicHintNorm, responseVariantScope);
      if (locationFallback) return sendJson(200, locationFallback);

      const exDef = extractiveDefinitionFallback(lower, selectedChunks);
      if (exDef) return sendJson(200, exDef);

      const fast = foundationFallbackIfNeeded(lower, scored);
      if (fast) return sendJson(200, fast);

      return sendJson(200, jsonFallback());
    }

      // ───────── Validação de citações melhorada para OCR ─────────
      const validCitations = citations
  .map(({ chunk, quote }) => ({ chunk, quote: String(quote).trim() }))
  .filter(({ chunk, quote }) => {
    if (!quote) return false;
    if (quote.length < 15) return false; // Reduzir de 20 para 15
    if (chunk < 0 || chunk >= selectedChunks.length) return false;

    const chunkTextNorm = normalizeForMatch(selectedChunks[chunk].text);
    const quoteNorm = normalizeForMatch(quote);
        
    // Verificação exata (como antes)
    if (chunkTextNorm.includes(quoteNorm)) return true;
        
    // Tolerância para OCR: verificar se a maioria das palavras está presente
    const quoteWords = quoteNorm.split(/\s+/).filter(w => w.length > 2);
    const chunkWords = chunkTextNorm.split(/\s+/).filter(w => w.length > 2);
        
    if (quoteWords.length === 0) return false;
        
    // Contar palavras que aparecem (parcialmente) no chunk
    let matchingWords = 0;
    for (const qWord of quoteWords) {
      // Procurar palavra completa ou parcial
      const found = chunkWords.some(cWord => 
        cWord.includes(qWord) || qWord.includes(cWord) ||
        // Para palavras curtas, verificar similaridade de prefixo
        (qWord.length <= 4 && cWord.startsWith(qWord.substring(0, Math.min(3, qWord.length))))
      );
      if (found) matchingWords++;
    }
        
    // Aceitar se pelo menos 70% das palavras correspondem OU se temos pelo menos 3 palavras correspondentes
    const matchRatio = matchingWords / quoteWords.length;
    return matchRatio >= 0.7 || matchingWords >= 3;
  });

if (validCitations.length === 0) {
  console.log("❌ Citações do JSON não batem no TEXTO do chunk indicado -> fallback");

  // Tentar fallback específico para reconhecimento de nível primeiro
  const nivelFallback = nivelRecognitionFallbackIfNeeded(lower, scored, responseVariantScope);
  if (nivelFallback) return sendJson(200, nivelFallback);

  // Tentar fallback específico para reconhecimento académico
  const academicFallback = academicRecognitionFallbackIfNeeded(lower, scored, responseVariantScope);
  if (academicFallback) return sendJson(200, academicFallback);

  // Tentar fallback específico para custos (genérico)
  const costFallback = costFallbackIfNeeded(lower, scored);
  if (costFallback) return sendJson(200, costFallback);

  // Tentar fallback específico para alojamento
  const housingFallback = housingFallbackIfNeeded(lower, scored);
  if (housingFallback) return sendJson(200, housingFallback);

  // Tentar fallback específico para localização
  const locationFallback = locationFallbackIfNeeded(lower, scored, topicHintNorm, responseVariantScope);
  if (locationFallback) return sendJson(200, locationFallback);

  const exDef = extractiveDefinitionFallback(lower, selectedChunks);
  if (exDef) return sendJson(200, exDef);

  const fast = foundationFallbackIfNeeded(lower, scored);
  if (fast) return sendJson(200, fast);

  return sendJson(200, jsonFallback());
}

// ───────── Regra especial: fundação+regime tem de mencionar o regime (aceita 1 frase / 1 citação) ─────────
if (fundacaoRegime) {
  const aNorm = stripDiacriticsLower(answerText);
  const answersRegime =
    mentionsRegimeDireitoPrivado(answerText) ||
    aNorm.includes("regime de direito privado") ||
    aNorm.includes("regime do direito privado");

  if (!answersRegime) {
    console.log("❌ Fundacao+regime: resposta não menciona o regime -> fallback determinístico");
    const fast = foundationFallbackIfNeeded(lower, scored);
    if (fast) return sendJson(200, fast);
    return sendJson(200, jsonFallback());
  }
    
  // PARA fundacaoRegime: aceitar 1 citação mesmo com 2+ frases
  // porque o answerSpec pede 2 frases mas a informação pode estar numa citação única
  const approxSentences = answerText.split(/[.!?]\s+/).filter(Boolean).length;
  const hasSubstantialCitation = validCitations.some(c => c.quote.length > 60);
    
  if (approxSentences >= 2 && validCitations.length < 2 && !hasSubstantialCitation) {
    console.log("⚠️ Fundacao+regime: resposta com 2+ frases mas apenas 1 citação - ACEITAR (regra especial)");
    // Não fazer fallback para este caso específico
  }
} else {
  // Regra original para outras perguntas
  const approxSentences = answerText.split(/[.!?]\s+/).filter(Boolean).length;
  const hasSubstantialCitation = validCitations.some(c => c.quote.length > 60);
    
  if (approxSentences >= 2 && validCitations.length < 2 && !hasSubstantialCitation) {
    console.log("❌ Resposta com 2+ frases sem citações suficientes -> fallback");

    // Tentar fallback específico para reconhecimento de nível primeiro
    const nivelFallback = nivelRecognitionFallbackIfNeeded(lower, scored, responseVariantScope);
    if (nivelFallback) return sendJson(200, nivelFallback);

    // Tentar fallback específico para reconhecimento académico
    const academicFallback = academicRecognitionFallbackIfNeeded(lower, scored, responseVariantScope);
    if (academicFallback) return sendJson(200, academicFallback);

    // Tentar fallback específico para custos (genérico)
    const costFallback = costFallbackIfNeeded(lower, scored);
    if (costFallback) return sendJson(200, costFallback);

    // Tentar fallback específico para alojamento
    const housingFallback = housingFallbackIfNeeded(lower, scored);
    if (housingFallback) return sendJson(200, housingFallback);

    // Tentar fallback específico para localização
    const locationFallback = locationFallbackIfNeeded(lower, scored, topicHintNorm, responseVariantScope);
    if (locationFallback) return sendJson(200, locationFallback);

    const exDef = extractiveDefinitionFallback(lower, selectedChunks);
    if (exDef) return sendJson(200, exDef);

    const fast = foundationFallbackIfNeeded(lower, scored);
    if (fast) return sendJson(200, fast);

    return sendJson(200, jsonFallback());
  }
}

const citationsOut = validCitations.slice(0, 3).map((c) => {
  const ch = selectedChunks[c.chunk];
  return { chunk: c.chunk, quote: c.quote, source: originOfChunk(ch) };
});

return sendJson(200, {
  answer: answerText,
  citations: citationsOut,
});
} catch (err) {
  console.error("🔥 Erro ao processar pergunta:", err);
  return res.status(500).json({ error: "Erro ao processar pergunta" });
}
});

app.listen(PORT, () => {
  console.log(`🚀 NOVA.Bot API ativa em http://localhost:${PORT}`);
  console.log(`🦙 Ollama host: ${OLLAMA_HOST}`);
  console.log(`🦙 Ollama model: ${OLLAMA_MODEL}`);
});
}

bootstrap().catch((err) => {
  console.error("🔥 Falha no arranque:", err);
  process.exit(1);
});