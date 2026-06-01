const fs = require("node:fs");
const path = require("node:path");
const {
  HISTORY_FILE,
  CODEX_HISTORY_ENTRY_CHARS,
  CODEX_MAX_HISTORY_ITEMS,
  CODEX_RECENT_HISTORY_ITEMS,
  CODEX_MAX_SUMMARY_CHARS,
} = require("./config");
const { nowIso } = require("./utils");
const {
  trimContext,
  summarizeEntries,
  appendSummary,
  buildPromptInput,
  normalizeAgentSession,
} = require("./promptBuilder");

const chatSessions = new Map();
let historySaveQueue = Promise.resolve();

const normalizeHistoryEntries = (value) => {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item && typeof item === "object")
    .map((item) => ({
      role: String(item.role || "assistant"),
      text: String(item.text || "").slice(0, CODEX_HISTORY_ENTRY_CHARS),
    }))
    .filter((item) => item.text.trim() && ["user", "assistant", "system"].includes(item.role));
};

const normalizeSummary = (value) => {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  return trimmed.slice(-CODEX_MAX_SUMMARY_CHARS);
};

const createEmptySession = () => ({
  summary: "",
  history: [],
  updatedAt: nowIso(),
});

const normalizeSession = (value) => {
  if (Array.isArray(value)) {
    return {
      summary: "",
      history: normalizeHistoryEntries(value).slice(-CODEX_MAX_HISTORY_ITEMS),
      updatedAt: nowIso(),
    };
  }
  if (!value || typeof value !== "object") return createEmptySession();
  return {
    summary: normalizeSummary(value.summary),
    history: normalizeHistoryEntries(value.history).slice(-CODEX_MAX_HISTORY_ITEMS),
    updatedAt:
      typeof value.updatedAt === "string" && value.updatedAt.trim() ? value.updatedAt : nowIso(),
  };
};

const compactSession = (session) => {
  if (!session || !Array.isArray(session.history)) return createEmptySession();
  let history = normalizeHistoryEntries(session.history);
  let summary = normalizeSummary(session.summary);

  while (history.length > CODEX_MAX_HISTORY_ITEMS) {
    const moved = history.splice(0, Math.max(1, history.length - CODEX_MAX_HISTORY_ITEMS));
    summary = appendSummary(summary, summarizeEntries(moved));
  }

  while (history.length > CODEX_RECENT_HISTORY_ITEMS) {
    const overflow = history.length - CODEX_RECENT_HISTORY_ITEMS;
    if (overflow <= 0) break;
    const moved = history.splice(0, overflow);
    summary = appendSummary(summary, summarizeEntries(moved));
  }

  session.summary = summary;
  session.history = history;
  session.updatedAt = nowIso();
  return session;
};

const getSession = (sessionKey) => {
  const existing = chatSessions.get(sessionKey);
  if (existing) return compactSession(existing);
  const created = createEmptySession();
  chatSessions.set(sessionKey, created);
  return created;
};

const buildPrompt = (payload) => {
  const userId = String(payload.userId || "anonymous");
  const chatId = String(payload.chatId || "default");
  const sessionKey = `${userId}::${chatId}`;
  const prompt = String(payload.prompt || "").trim();
  const fullPromptInput = String(payload.fullPrompt || "").trim();
  const systemPrompt = String(payload.systemPrompt || "").trim();
  const contextText = trimContext(String(payload.contextText || ""));
  const agentSession = normalizeAgentSession(payload.agentSession);
  if (!prompt && !fullPromptInput) throw new Error("prompt or fullPrompt is required");

  if (fullPromptInput) {
    return {
      userId,
      chatId,
      sessionKey,
      prompt: prompt || "(fullPrompt)",
      fullPrompt: fullPromptInput,
    };
  }

  const session = getSession(sessionKey);
  const working = compactSession({
    summary: session.summary,
    history: [...session.history],
    updatedAt: session.updatedAt,
  });

  const built = buildPromptInput({
    systemPrompt,
    contextText,
    agentSession,
    summary: working.summary,
    history: working.history,
    prompt,
  });

  return {
    userId,
    chatId,
    sessionKey,
    prompt,
    fullPrompt: built.fullPrompt,
    session,
  };
};

const addExecutionResultToSession = ({ sessionKey, prompt, message }) => {
  const session = getSession(sessionKey);
  session.history.push({ role: "user", text: String(prompt || "").slice(0, CODEX_HISTORY_ENTRY_CHARS) });
  if (message) {
    session.history.push({ role: "assistant", text: String(message).slice(0, CODEX_HISTORY_ENTRY_CHARS) });
  }
  compactSession(session);
  chatSessions.set(sessionKey, session);
};

const loadHistoryFromDisk = async () => {
  try {
    const raw = await fs.promises.readFile(HISTORY_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return;
    Object.entries(parsed).forEach(([key, value]) => {
      const normalized = normalizeSession(value);
      if (normalized.history.length || normalized.summary) {
        chatSessions.set(key, normalized);
      }
    });
  } catch (error) {
    if (error && error.code !== "ENOENT") {
      console.error("[codex-gateway] failed to load history:", error.message || error);
    }
  }
};

const queueSaveHistory = () => {
  const serializable = Object.fromEntries(
    Array.from(chatSessions.entries()).map(([key, value]) => [
      key,
      {
        summary: normalizeSummary(value.summary),
        history: normalizeHistoryEntries(value.history),
        updatedAt: value.updatedAt || nowIso(),
      },
    ]),
  );
  const snapshot = JSON.stringify(serializable);
  historySaveQueue = historySaveQueue
    .then(async () => {
      await fs.promises.mkdir(path.dirname(HISTORY_FILE), { recursive: true });
      await fs.promises.writeFile(HISTORY_FILE, snapshot, "utf8");
    })
    .catch((error) => {
      console.error("[codex-gateway] failed to save history:", error.message || error);
    });
  return historySaveQueue;
};

module.exports = {
  chatSessions,
  buildPrompt,
  addExecutionResultToSession,
  loadHistoryFromDisk,
  queueSaveHistory,
  compactSession,
  getSession,
};
