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
 */
import { SIZE_FIELD } from "./_sizes.js";

export function boxFields({ orderId, name, type, qty, breakdown }) {
  return {
    Name: String(name).slice(0, 80),
    Order__c: orderId,
    Packaging_Type__c: type,
    Packaging_Quantity__c: qty,
    ...(breakdown ? { [SIZE_FIELD]: breakdown } : {}),
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
