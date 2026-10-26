/**
 * "Quantity + Size Counted" -- the size-by-size count of one box.
 *
 * Stored on Order_Packaging__c in ONE text field (Quantity_Size_Counted__c, 255),
 * next to the number field Packaging_Quantity__c, which holds the box's total.
 * The total is always worked out here from the size counts, so the two can never
 * disagree. (Decided by Anthony 2026-10-15.)
 *
 * Sizes are NOT a fixed list: OrderItem.Size__c is free text in Production, so a
 * box can only be counted in the sizes that are on its own order.
 *
 * Format (readable on the record, and read back by the app):
 *   order with one garment:      "S 8 · M 15 · L 17 · XL 10 = 50"
 *   order with several garments: "Blue Spruce Comfort Colors 1717: S 8 · M 15 | Ivory Comfort Colors 3023CL: L 4 = 27"
 * Several garments in one box are allowed.
 *
 * EXTRAS (Anthony 2026-10-26): the garment supplier sometimes sends extras, and the
 * shop prints and boxes them for the customer. A box can hold a size that ISN'T on
 * the order ("Add More" on the box form). Those are written with " (extra)":
 *   "S 8 · M 15 · 2XL 3 (extra) = 26"
 * Extras count toward the box's total (Packaging_Quantity__c), because they really
 * are in the box. (Extras of a size already on the order are just counted in that
 * size, past what the order lists.)
 */
export const SIZE_FIELD = "Quantity_Size_Counted__c";
export const SIZE_FIELD_MAX = 255;

const SEP_ITEM = " · ", SEP_GROUP = " | ";
export const EXTRA_MARK = " (extra)";
const EXTRA_SIZE_RE = /^[A-Z0-9][A-Z0-9 \/.-]{0,9}$/;

/** An extra size typed or picked on the tablet -> "2XL", or "" if it can't be used. */
export function cleanExtraSize(s) {
  const v = String(s == null ? "" : s).toUpperCase().replace(/\s+/g, " ").trim();
  return EXTRA_SIZE_RE.test(v) ? v : "";
}

function cleanPart(s, max) {
  return String(s == null ? "" : s).replace(/[:|·=\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

/** The words a garment line is written with. level 0 = colour + product, 1 = colour or product, 2 = "Garment n". */
export function garmentLabel(line, idx, level = 0) {
  const color = cleanPart(line.color, 30), product = cleanPart(line.product, 40);
  if (level === 0) return cleanPart((color ? color + " " : "") + product, 60) || `Garment ${idx + 1}`;
  if (level === 1) return color || product || `Garment ${idx + 1}`;
  return `Garment ${idx + 1}`;
}

/**
 * counts: [{ line, size, qty }] (line = index into order.lines).
 * Returns { text, total } or throws an Error whose message a catcher can read.
 */
export function buildBreakdown(lines, counts) {
  const multi = lines.length > 1;
  const byLine = new Map();
  let total = 0;
  for (const c of counts) {
    if (!c.qty) continue;
    if (!byLine.has(c.line)) byLine.set(c.line, []);
    byLine.get(c.line).push(c);
    total += c.qty;
  }
  const order = [...byLine.keys()].sort((a, b) => a - b);
  for (let level = 0; level <= 2; level++) {
    // Each garment's words must be unique on the order, or it can't be read back.
    const labels = lines.map((l, i) => garmentLabel(l, i, level));
    if (multi && new Set(labels).size !== labels.length) continue;
    const groups = order.map((li) => {
      const line = lines[li];
      // sizes in the order they appear on the order (S, M, L ...)
      // (extras -- sizes not on the order -- come after the order's own sizes)
      const rank = new Map(line.sizes.map((s, i) => [s.size, i]));
      const r = (c) => (c.extra ? 1000 : (rank.has(c.size) ? rank.get(c.size) : 999));
      const items = byLine.get(li).slice().sort((a, b) => r(a) - r(b))
        .map((c) => `${c.size} ${c.qty}${c.extra ? EXTRA_MARK : ""}`).join(SEP_ITEM);
      return (multi ? garmentLabel(line, li, level) + ": " : "") + items;
    });
    const text = groups.join(SEP_GROUP) + ` = ${total}`;
    if (text.length <= SIZE_FIELD_MAX) return { text, total };
  }
  throw new Error("Too many sizes in one box to save. Split it into two boxes.");
}

/**
 * Read a saved breakdown back into [{ line, size, qty }], matched to this order's
 * lines. Anything that doesn't match (an old box, a hand edit) gives [] -- the
 * box then just shows its total, as before.
 */
export function parseBreakdown(lines, text) {
  if (!text || typeof text !== "string") return [];
  const body = text.replace(/\s*=\s*\d+\s*$/, "");
  const multi = lines.length > 1;
  const out = [];
  for (const group of body.split(SEP_GROUP)) {
    let li = 0, items = group;
    if (multi) {
      const at = group.indexOf(": ");
      if (at < 0) return [];
      const label = group.slice(0, at);
      li = -1;
      for (let level = 0; level <= 2 && li < 0; level++) {
        const labels = lines.map((l, i) => garmentLabel(l, i, level));
        if (new Set(labels).size !== labels.length) continue;
        li = labels.indexOf(label);
      }
      if (li < 0) return [];
      items = group.slice(at + 2);
    }
    for (const item of items.split(SEP_ITEM)) {
      const m = item.trim().match(/^(.*\S)\s+(\d{1,4})(\s+\(extra\))?$/);
      if (!m) return [];
      const size = m[1];
      if (!lines[li]) return [];
      const onOrder = lines[li].sizes.some((s) => s.size === size);
      if (m[3]) {
        // an extra: a size beyond the order (if the order has since gained that size, it counts there)
        if (cleanExtraSize(size) !== size) return [];
        out.push(onOrder ? { line: li, size, qty: Number(m[2]) } : { line: li, size, qty: Number(m[2]), extra: true });
        continue;
      }
      if (!onOrder) return [];
      out.push({ line: li, size, qty: Number(m[2]) });
    }
  }
  return out;
}
