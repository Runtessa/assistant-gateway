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

const composePrompt = ({ systemPrompt, contextText, summary, history, prompt }) => {
  const sections = [];
  const sys = String(systemPrompt || "").trim();
  const ctx = String(contextText || "").trim();
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
    sections.push("WORKSPACE CONTEXT:");
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

const buildPromptInput = ({ systemPrompt, contextText, summary, history, prompt }) => {
  let nextSummary = summary;
  let nextHistory = [...history];
  let fullPrompt = composePrompt({
    systemPrompt,
    contextText,
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
};
