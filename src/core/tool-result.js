// Shared interpretation of existing tool receipts. Keep string/JSON APIs intact;
// classification must not depend on where a renderer places its metadata header.
import { TOOL_ERROR_PREFIX } from "./errors.js";

export function toolResultStatus(result) {
  if (result?.kind === "ppx-tool-outcome" && result.status && typeof result.status.ok === "boolean") {
    return result.status;
  }
  const text = typeof result === "string" ? result : JSON.stringify(result ?? "");
  let value = result && typeof result === "object" ? result : null;
  if (!value && text.trimStart().startsWith("{")) {
    try { value = JSON.parse(text); } catch { /* ordinary text */ }
  }
  const header = text.match(/^(?:\[工具错误\]\s*)?\[exit=([^\s\]]+)/);
  const exit = header?.[1];
  const exitCode = exit !== undefined && /^-?\d+$/.test(exit) ? Number(exit) : null;
  const prefixed = text.startsWith(TOOL_ERROR_PREFIX) || /^\[hook\]|^\[permission\]/.test(text);
  const timedOut = exit === "timeout" || value?.timedOut === true || value?.status === "timeout"
    || (prefixed && /超时|timed?\s*out|timeout/i.test(text));
  const failed = prefixed || timedOut || (exit !== undefined && exit !== "0")
    || value?.ok === false || Boolean(value?.error) || value?.isError === true;
  return { ok: !failed, timedOut, exitCode, error: failed ? String(value?.error || text) : null };
}

// Only the actual provider/caller constructs this object; JSON text from files
// is never decoded as this protocol. Seam renders content for public callers.
export function toolOutcome(content, status = { ok: true, timedOut: false, exitCode: null, error: null }) {
  return { kind: "ppx-tool-outcome", content, status };
}

export function toolResultContent(result) {
  return result?.kind === "ppx-tool-outcome" ? result.content : result;
}
