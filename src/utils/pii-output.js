// Reuse the PII scanner on outbound text leaves without mutating internal events.
import { scrubPII } from "./pii.js";

const SECRET_FIELD = /^(?:password|passwd|pwd|secret|secret[_-]?key|api[_-]?key|access[_-]?token|auth[_-]?token|token|authorization|cookie|private[_-]?key)$/i;

export function maskPIIOutput(value) {
  const seen = new WeakSet();
  const visit = (item, depth = 0) => {
    if (typeof item === "string") return scrubPII(item).cleaned;
    if (item == null || typeof item === "number" || typeof item === "boolean") return item;
    if (typeof item !== "object" || depth > 32 || seen.has(item)) throw new Error("unmaskable output");
    seen.add(item);
    const masked = Array.isArray(item) ? item.map((v) => visit(v, depth + 1))
      : Object.fromEntries(Object.entries(item).map(([key, v]) => [
        key, SECRET_FIELD.test(key) && v != null && v !== "" ? "[REDACTED]" : visit(v, depth + 1),
      ]));
    seen.delete(item);
    return masked;
  };
  try { return visit(value); }
  catch { return "[REDACTED]"; } // A masking failure must never fall back to raw content.
}
