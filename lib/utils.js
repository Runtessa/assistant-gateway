const nowIso = () => new Date().toISOString();

const createId = (prefix) => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}-${Date.now()}`;
};

const stripAnsi = (value) =>
  String(value || "")
    .replace(/\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/g, "")
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, "");

const parseUserCode = (line) => {
  const clean = stripAnsi(line).toUpperCase();
  const match = clean.match(/\b(?=[A-Z0-9-]*\d)[A-Z0-9]{4,8}(?:-[A-Z0-9]{4,8})+\b/);
  return match ? match[0] : "";
};

const parseAuthUrl = (line) => {
  const clean = stripAnsi(line);
  const match = clean.match(/https?:\/\/[^\s"'<>]+/);
  if (!match) return "";
  return match[0].replace(/[.,;:!?]+$/, "");
};

const isRateLimitText = (value) =>
  /\b429\b/i.test(String(value || "")) || /too many requests/i.test(String(value || ""));

module.exports = {
  nowIso,
  createId,
  stripAnsi,
  parseUserCode,
  parseAuthUrl,
  isRateLimitText,
};
