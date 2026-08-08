// Text that came from outside this plugin, handled the same way wherever it lands.
//
// A Worker's fields, a Codex binary's stdout, an event's message: none of it is the Runner's own
// prose, and every one of them arrives possibly empty, possibly enormous and possibly carrying
// newlines into a line the Runner is composing. These three answers are shared because both the
// Delegation path and readiness quote text they did not write, and two spellings of "is this
// filled in" would drift in the one place a difference is invisible — a field that reads as present
// on one path and absent on the other.

/** How much of a Worker's own text a one-line quotation of it carries. */
const ONE_LINE_MAX_CHARS = 120;

/**
 * Whether a Worker filled a string field in at all. Every Result reaches the checks and the
 * renderings having been reported as imperfect rather than refused, so both halves ask this the
 * same way: a missing field costs a line, never the answer.
 */
export function filled(value) {
  return typeof value === "string" && value.trim() !== "";
}

/** A Worker's string field, trimmed, or the fallback when it left the field empty. */
export function text(value, fallback = "") {
  return filled(value) ? value.trim() : fallback;
}

/** A Worker's text on one line, collapsed and capped — for the places the Runner quotes it inline. */
export function oneLine(value, max = ONE_LINE_MAX_CHARS) {
  const collapsed = String(value ?? "").replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}
