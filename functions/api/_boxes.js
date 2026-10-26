/**
 * The ONE place that says what a box record looks like in Salesforce.
 * Used by every way of creating a box (log a box, Save Box & New, Duplicate Box),
 * so they can never drift apart.
 *
 * Order_Packaging__c:
 *   Name                      "Garment Type": shop word + box number, e.g. "Tees 3"
 *   Order__c                  the order
 *   Packaging_Type__c         "Packaging Type"
 *   Packaging_Quantity__c     the box's total garments (number)
 *   Quantity_Size_Counted__c  "Quantity + Size Counted", e.g. "S 8 · M 15 = 23" (blank if unknown)
 *   CountedBy__c             "Counted By": the signed-in catcher (see below)
 */
import { SIZE_FIELD, buildBreakdown, cleanExtraSize } from "./_sizes.js";

/**
 * "Counted By" (CountedBy__c, Text 80, added 2026-10-15): the signed-in catcher who
 * logged the box. Every box is saved through the app's one Salesforce login, so
 * Salesforce's own Created By always says "Catcher App" -- this field is what says
 * WHO it was. Set when a box is created (log, Save & New, duplicate); an edit keeps it.
 */
export const COUNTED_BY_FIELD = "CountedBy__c";

export function boxFields({ orderId, name, type, qty, breakdown, countedBy }) {
  return {
    Name: String(name).slice(0, 80),
    Order__c: orderId,
    Packaging_Type__c: type,
    Packaging_Quantity__c: qty,
    ...(breakdown ? { [SIZE_FIELD]: breakdown } : {}),
    ...(countedBy ? { [COUNTED_BY_FIELD]: String(countedBy).slice(0, 80) } : {}),
  };
}

/** "Tees 3" -> "Tees"; "Tees + Hoodies 12" -> "Tees + Hoodies". */
export function garmentWord(name) {
  return String(name || "").replace(/\s+\d+$/, "").trim() || "Box";
}

/**
 * The next `count` Garment Type names for boxes of this kind on this order,
 * numbered after the boxes already there: Tees 3, Tees 4, ...
 */
export function nextNames(existingBoxes, word, count) {
  const re = new RegExp("^" + word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?:\\s+(\\d+))?$");
  let top = 0;
  for (const b of existingBoxes) {
    const m = String(b.name || "").match(re);
    if (m) top = Math.max(top, m[1] ? Number(m[1]) : 1);
  }
  return Array.from({ length: count }, (_, i) => `${word} ${top + i + 1}`);
}


/** Shape check before anything is read: whole numbers only. Returns an error message or "". */
export function countsShapeError(counts) {
  if (!Array.isArray(counts)) return "Count at least one size.";
  if (counts.length > 80) return "Too many sizes in one box. Split it into two boxes.";
  for (const c of counts) {
    if (!c || !Number.isInteger(c.line) || typeof c.size !== "string" || !Number.isInteger(c.qty) || c.qty < 0 || c.qty > 9999 ||
        (c.extra !== undefined && typeof c.extra !== "boolean")) {
      return "A size count isn't a whole number. Check the counts and try again.";
    }
  }
  return "";
}

/**
 * Size counts checked against the order's own garments and sizes.
 * Returns { clean, qty, breakdown } or { error, message }. Used by Log Box,
 * Save Box & New and Edit Box, so they all accept exactly the same counts.
 *
 * EXTRAS ("Add More", 2026-10-26): a count marked extra: true may be a size that
 * isn't on that garment (the supplier sent extras). It must be a short size name;
 * it still has to belong to one of the order's garments. An "extra" that turns out
 * to be a size already on the order is simply counted in that size.
 */
export function checkCounts(order, counts) {
  const seen = new Set();
  const clean = [];
  for (const c of counts) {
    const line = order.lines[c.line];
    if (!line) return { error: "bad_size", message: "That garment isn't on this order. Refresh and try again." };
    let size = c.size, extra = false;
    if (!line.sizes.some((s) => s.size === size)) {
      const typed = c.extra === true ? cleanExtraSize(size) : "";
      if (!typed) {
        return { error: "bad_size", message: c.extra === true
          ? `"${String(c.size).slice(0, 12)}" can't be used as a size. Use letters and numbers, up to 10.`
          : `"${String(c.size).slice(0, 12)}" isn't a size on this order. Refresh and try again.` };
      }
      const same = line.sizes.find((s) => s.size.toUpperCase() === typed);
      if (same) size = same.size; else { size = typed; extra = true; }
    }
    const k = c.line + "|" + size;
    if (seen.has(k)) return { error: "bad_counts", message: "The same size was sent twice. Try again." };
    seen.add(k);
    if (c.qty) clean.push(extra ? { line: c.line, size, qty: c.qty, extra: true } : { line: c.line, size, qty: c.qty });
  }
  const qty = clean.reduce((a, c) => a + c.qty, 0);
  if (qty < 1 || qty > 9999) return { error: "bad_qty", message: "A box needs between 1 and 9999 garments." };
  try {
    return { clean, qty, breakdown: buildBreakdown(order.lines, clean).text };
  } catch (e) {
    return { error: "too_long", message: e.message };
  }
}
