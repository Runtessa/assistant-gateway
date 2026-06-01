const {
  CODEX_MAX_CONTEXT_CHARS,
  CODEX_MAX_PROMPT_CHARS,
  CODEX_MAX_SUMMARY_CHARS,
} = require("./config");

const trimContext = (value) => {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.length <= CODEX_MAX_CONTEXT_CHARS) return text;
  return `${text.slice(0, CODEX_MAX_CONTEXT_CHARS)}\n…(context truncated by gateway)`;
};

const trimJson = (value) => trimContext(JSON.stringify(value, null, 2));

const summarizeEntries = (entries) =>
  entries
    .map((entry) => {
      const role = entry.role === "assistant" ? "Assistant" : "User";
      const compact = String(entry.text || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 220);
      return compact ? `${role}: ${compact}` : "";
    })
    .filter(Boolean)
    .join("\n");

const appendSummary = (existing, chunk) => {
  const parts = [String(existing || "").trim(), String(chunk || "").trim()].filter(Boolean);
  if (!parts.length) return "";
  return parts.join("\n").slice(-CODEX_MAX_SUMMARY_CHARS);
};

const normalizeAgentSession = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const files = Array.isArray(value.workspace?.files)
    ? value.workspace.files
        .filter((item) => item && typeof item === "object")
        .map((item) => ({
          path: String(item.path || ""),
          kind: String(item.kind || "file"),
          entityName: String(item.entityName || ""),
          projectName: String(item.projectName || ""),
          version: String(item.version || ""),
          dependencies: Array.isArray(item.dependencies)
            ? item.dependencies.map((entry) => String(entry))
            : [],
          content: String(item.content || ""),
        }))
        .filter((item) => item.path)
    : [];
  return {
    version: String(value.version || ""),
    chatId: String(value.chatId || "default"),
    tenant: value.tenant || null,
    actor: value.actor || null,
    runtime: value.runtime || {},
    workspace: {
      stats: value.workspace?.stats || {},
      activeFile: value.workspace?.activeFile || null,
      files,
    },
    acl: value.acl || {},
    preview: {
      enabled: Boolean(value.preview?.enabled),
      exceptions: Array.isArray(value.preview?.exceptions)
        ? value.preview.exceptions.slice(0, 10)
        : [],
    },
    task: value.task || {},
  };
};

const composeAgentSessionContext = (agentSession) => {
  const session = normalizeAgentSession(agentSession);
  if (!session) return "";

  const lines = [];
  lines.push("TENANT SESSION MANIFEST JSON:");
  lines.push(
    trimJson({
      version: session.version,
      chatId: session.chatId,
      tenant: session.tenant,
      actor: session.actor,
      runtime: session.runtime,
      workspace: {
        stats: session.workspace.stats,
        activeFile: session.workspace.activeFile,
        files: session.workspace.files.map((file) => ({
          path: file.path,
          kind: file.kind,
          entityName: file.entityName,
          projectName: file.projectName,
          version: file.version,
          dependencies: file.dependencies,
        })),
      },
      acl: session.acl,
      task: session.task,
      preview: {
        enabled: session.preview.enabled,
        count: session.preview.exceptions.length,
      },
    }),
  );
  lines.push("");
  lines.push("WORKSPACE NOTE:");
  lines.push("All tenant files listed in the manifest are available on disk in the current working directory.");
  lines.push("PREVIEW EXCEPTIONS:");
  if (!session.preview.enabled) {
    lines.push("Watch mode: disabled");
  } else if (!session.preview.exceptions.length) {
    lines.push("Watch mode: enabled, no recent exceptions");
  } else {
    session.preview.exceptions.forEach((item, index) => {
      lines.push(`# EXCEPTION ${index + 1}: [${String(item.level || "info")}] ${String(item.kind || "event")}`);
      lines.push(`message: ${String(item.message || "")}`);
      if (item.requestUrl) lines.push(`request: ${String(item.method || "GET")} ${String(item.requestUrl)}`);
      if (item.sourceUrl) lines.push(`source: ${String(item.sourceUrl)}`);
      if (item.responseSnippet) lines.push(`response: ${String(item.responseSnippet)}`);
      if (item.stack) lines.push(trimContext(String(item.stack)));
      lines.push("");
    });
  }
  return trimContext(lines.join("\n"));
};

const composePrompt = ({ systemPrompt, contextText, agentSession, summary, history, prompt }) => {
  const sections = [];
  const sys = String(systemPrompt || "").trim();
  const ctx = agentSession ? composeAgentSessionContext(agentSession) : String(contextText || "").trim();
  const sum = String(summary || "").trim();
  const hist = Array.isArray(history)
    ? history
        .map((entry) => `[${entry.role}] ${entry.text}`)
        .join("\n")
        .trim()
    : "";
  const latest = String(prompt || "").trim();

  if (sys) {
    sections.push("SYSTEM INSTRUCTIONS:");
    sections.push(sys);
  }
  if (ctx) {
    sections.push(agentSession ? "TENANT SESSION CONTRACT:" : "WORKSPACE CONTEXT:");
    sections.push(ctx);
  }
  if (sum) {
    sections.push("COMPACTED CHAT SUMMARY:");
    sections.push(sum);
  }
  if (hist) {
    sections.push("RECENT CHAT HISTORY:");
    sections.push(hist);
  }

  sections.push("LATEST USER MESSAGE:");
  sections.push(latest || "(empty)");
  return sections.join("\n\n").trim();
};

const buildPromptInput = ({ systemPrompt, contextText, agentSession, summary, history, prompt }) => {
  let nextSummary = summary;
  let nextHistory = [...history];
  let fullPrompt = composePrompt({
    systemPrompt,
    contextText,
    agentSession,
    summary: nextSummary,
    history: nextHistory,
    prompt,
  });

  while (fullPrompt.length > CODEX_MAX_PROMPT_CHARS && nextHistory.length > 2) {
    const chunk = nextHistory.splice(0, Math.max(1, Math.ceil(nextHistory.length / 4)));
    nextSummary = appendSummary(nextSummary, summarizeEntries(chunk));
    fullPrompt = composePrompt({
      systemPrompt,
      contextText,
      agentSession,
      summary: nextSummary,
      history: nextHistory,
      prompt,
    });
  }

  if (fullPrompt.length > CODEX_MAX_PROMPT_CHARS) {
    fullPrompt = `${fullPrompt.slice(0, CODEX_MAX_PROMPT_CHARS)}\n…(prompt truncated by gateway)`;
  }

  return {
    fullPrompt,
    summary: nextSummary,
    history: nextHistory,
  };
};

module.exports = {
  trimContext,
  summarizeEntries,
  appendSummary,
  composePrompt,
  buildPromptInput,
  normalizeAgentSession,
  composeAgentSessionContext,
};
