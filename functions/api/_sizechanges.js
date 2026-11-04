/**
 * SIZES CHANGED (11-04): the supplier sent different sizes than were ordered, the customer said
 * "print what you got", so the shop prints the sizes that arrived.
 *
 * Kept on the Order in Salesforce, in the Long Text field Size_Changes__c ("Size Changes"), one line
 * per garment, readable by anyone in the office:
 *
 *   Black Comfort Colors 1717: M 6→3, L 10→13 · Titus, 11/4/2026 · Supplier sent 3 more L and 3 fewer M.
 *
 *   <garment label> : <size> <ordered>→<received>, ... · <who>, <M/D/YYYY> [· <why>]
 *
 * The garment label is the same one the box records use ("Black Comfort Colors 1717"). The app reads
 * these lines back to know how many of each size to EXPECT: the order's products are never changed
 * (quotes and invoices stay as they are). A line someone typed by hand that doesn't fit the pattern is
 * kept as it is and ignored for the counts.
 */
import { garmentLabel } from "./_sizes.js";

export const SIZE_CHANGES_FIELD = "Size_Changes__c";
/* The customer's answer (11-04, shared with The Forge -- its functions/api/_size-swap.js;
   keep the values identical). Optional Order picklist. No field in the org = every line means
   "Print what was sent" (what this app's own form records). Blank = receiving recorded the
   swap and the account manager hasn't answered yet: count the order as sold. */
export const ANSWER_FIELD = "Size_Swap_Answer__c";
export const ANSWERS = {
  sent: "Print what was sent",
  sentReorder: "Print what was sent + reorder missing",
  originals: "Print original sizes + reorder missing",
};
const ANSWER_KEY = new Map(Object.entries(ANSWERS).map(([k, v]) => [v.toLowerCase(), k]));
export function answerKeyOf(answer, answerField) {
  if (!answerField) return "sent";
  return ANSWER_KEY.get(String(answer || "").trim().toLowerCase()) || "waiting";
}
/** How many of a size to print (and so to catch), by the customer's answer. */
export function expectedQty(ordered, received, key) {
  if (key === "sent") return received;
  if (key === "sentReorder") return Math.max(ordered, received);
  return ordered; // originals, waiting
}
export const MAX_TEXT = 32000;
const LINE_RE = /^(.+?): (.+?) · (.+?), (\d{1,2}\/\d{1,2}\/\d{4})(?: · (.*))?$/;
const PAIR_RE = /^(\S{1,12}) (\d{1,4})→(\d{1,4})$/;

/** One label per garment, unique on the order (same rule as the box breakdown). */
export function lineLabels(lines) {
  for (let level = 0; level <= 2; level++) {
    const labels = lines.map((l, i) => garmentLabel(l, i, level));
    if (lines.length < 2 || new Set(labels).size === labels.length) return labels;
  }
  return lines.map((l, i) => `Garment ${i + 1}`);
}

/** Text -> [{ label, pairs: [{size, ordered, received}], by, date, note, raw }] (raw lines that don't parse: { raw }). */
export function parseSizeChanges(text) {
  return String(text || "").split(/\r?\n/).map((raw) => raw.trim()).filter(Boolean).map((raw) => {
    const m = LINE_RE.exec(raw);
    if (!m) return { raw };
    const pairs = [];
    for (const part of m[2].split(/,\s*/)) {
      const p = PAIR_RE.exec(part.trim());
      if (!p) return { raw };
      pairs.push({ size: p[1], ordered: Number(p[2]), received: Number(p[3]) });
    }
    return { label: m[1], pairs, by: m[3], date: m[4], note: m[5] || "", raw };
  });
}

/** Chicago date as M/D/YYYY. */
export function shopDate(d = new Date()) {
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", month: "numeric", day: "numeric", year: "numeric" }).format(d);
}

/** Text safe for one line: no line breaks, no " · " (it separates the parts), trimmed. */
export function oneLine(v, max) {
  return String(v == null ? "" : v).replace(/[\u0000-\u001F\u007F]+/g, " ").replace(/\s·\s/g, " - ").replace(/\s+/g, " ").trim().slice(0, max);
}

export function formatLine(label, pairs, by, date, note) {
  const sizes = pairs.map((p) => `${p.size} ${p.ordered}→${p.received}`).join(", ");
  return `${label}: ${sizes} · ${oneLine(by, 60) || "Catcher"}, ${date}` + (note ? ` · ${note}` : "");
}

/**
 * Apply the saved changes to an order's lines (in place): each changed size keeps `ordered` (what the
 * order says) and its `qty` becomes what was received, so "left", totals, warnings and Finish all count
 * against what arrived. Each changed line gets `changed: { pairs, by, date, note }`.
 */
export function applySizeChanges(lines, text, key = "sent") {
  if (!text) return;
  const labels = lineLabels(lines);
  for (const e of parseSizeChanges(text)) {
    if (!e.label) continue;
    const i = labels.indexOf(e.label);
    if (i < 0) continue;
    const line = lines[i];
    const pairs = [];
    for (const p of e.pairs) {
      const s = line.sizes.find((x) => x.size === p.size);
      if (!s) continue;
      if (s.ordered == null) s.ordered = s.qty;
      s.received = p.received;                         // what arrived (kept for the form)
      s.qty = expectedQty(s.ordered, p.received, key); // what to catch
      pairs.push({ size: s.size, ordered: s.ordered, received: p.received });
    }
    if (!pairs.length) continue;
    line.changed = { pairs, by: e.by, date: e.date, note: e.note, key, waiting: key === "waiting" };
    line.total = line.sizes.reduce((a, s) => a + s.qty, 0);
  }
}

/** The whole field after replacing (or removing, when pairs is empty) one garment's line. */
export function replaceLine(text, label, newLine) {
  const kept = String(text || "").split(/\r?\n/).map((r) => r.trim()).filter(Boolean).filter((raw) => {
    const e = parseSizeChanges(raw)[0];
    return !(e && e.label === label);
  });
  if (newLine) kept.push(newLine);
  return kept.join("\n");
}
