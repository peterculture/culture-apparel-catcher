/**
 * Which orders the catchers see, and how one is read.
 *
 * The rule matches Production's "Print Shop" Order list view
 * (API name Copy_of_Pre_Production, read 2026-10-14), In Production column:
 *   Production Status (Order_Substatus__c) = In Production  -- stored value "Production"
 *   Printer (Printer__r.Name) is "Culture Apparel" or "Culture Apparel Press 2"  -- screen print
 *   Print Date (Print_Date__c) is later than 10 days ago
 *
 * Optional variable PRINTER_NAMES (comma separated) overrides the printer list
 * if a press is added or renamed, without a code change.
 *
 * STAYING ON THE BOARD UNTIL COUNTED (Anthony, 2026-10-15):
 * the print crew sometimes moves an order to Post-Production before the catcher
 * has finished logging boxes. So once an order has been on the board, it STAYS
 * on the board -- whatever its Production Status -- until a catcher taps
 * FINISH CATCHING, which writes the box count to Order.Packaging_Count__c.
 *   - "Has been on the board" is remembered in KV (key board:seen), for 14 days.
 *   - Finished = Packaging_Count__c is filled in.
 * The crew is never blocked; nothing about their process changes.
 */
import { runQuery, soqlQuote, plainText, SfError, SF_ID } from "./_sf.js";
import { SIZE_FIELD, parseBreakdown } from "./_sizes.js";

export const DEFAULT_PRINTERS = ["Culture Apparel", "Culture Apparel Press 2"];

export function printerNames(env) {
  const list = String(env.PRINTER_NAMES || "").split(",").map((s) => s.trim()).filter(Boolean);
  return list.length ? list : DEFAULT_PRINTERS;
}

export function inProductionWhere(env) {
  return `Order_Substatus__c = 'Production'` +
    ` AND Printer__r.Name IN (${printerNames(env).map(soqlQuote).join(",")})` +
    ` AND Print_Date__c > N_DAYS_AGO:10`;
}

const ORDER_FIELDS = [
  "Id", "OrderNumber", "GOA_Order_Number__c", "Account.Name",
  "Print_Date__c", "Printer__r.Name", "Specifications_for_Printing__c",
  "TotalQtyMisprints__c", "Misprint_Details__c", "Artwork_URL__c", "LastModifiedDate",
  "Order_Substatus__c", "Packaging_Count__c",
];

const SEEN_KEY = "board:seen";
const SEEN_MS = 14 * 86400000;

/** orderId -> first time it was on the board (ms). Empty without KV. */
async function readSeen(env) {
  if (!env.CATCHER_KV) return {};
  try {
    const v = JSON.parse((await env.CATCHER_KV.get(SEEN_KEY)) || "{}");
    return v && typeof v === "object" ? v : {};
  } catch (_) { return {}; }
}

/** After a full list load: remember what is In Production now; forget what has left the board. */
async function writeSeen(env, seen, orders) {
  if (!env.CATCHER_KV) return;
  const now = Date.now();
  const next = {};
  for (const o of orders) {
    if (o.inProduction || !o.finished) next[o.id] = seen[o.id] || now;
  }
  const a = JSON.stringify(Object.keys(next).sort()), b = JSON.stringify(Object.keys(seen).sort());
  if (a === b) return;
  try { await env.CATCHER_KV.put(SEEN_KEY, JSON.stringify(next)); } catch (err) { console.error("board:seen write failed", err && err.message); }
}

const SIZE_ORDER = ["YXS", "YS", "YM", "YL", "YXL", "XXS", "XS", "S", "M", "L", "XL", "2XL", "XXL", "3XL", "XXXL", "4XL", "5XL", "6XL", "OSFA", "OS"];
function sizeRank(s) {
  const i = SIZE_ORDER.indexOf(String(s || "").toUpperCase().replace(/\s+/g, ""));
  return i < 0 ? 100 : i;
}

/** The orders the app may show — and therefore the only orders it may write to. */
export async function loadOrders(env, { orderId } = {}) {
  const seen = await readSeen(env);
  const cutoff = Date.now() - SEEN_MS;
  const carry = Object.keys(seen).filter((id) => SF_ID.test(id) && Number(seen[id]) > cutoff).slice(0, 150);
  let where = `(${inProductionWhere(env)})`;
  if (carry.length) where = `(${where} OR (Id IN (${carry.map(soqlQuote).join(",")}) AND Packaging_Count__c = null))`;
  if (orderId) where += ` AND Id = ${soqlQuote(orderId)}`;
  const orders = await runQuery(env,
    `SELECT ${ORDER_FIELDS.join(", ")} FROM Order WHERE ${where} ORDER BY Print_Date__c ASC, OrderNumber ASC LIMIT 200`);
  if (!orders.length) { if (!orderId) await writeSeen(env, seen, []); return []; }

  const ids = orders.map((o) => soqlQuote(o.Id)).join(",");
  const [items, boxes] = await Promise.all([
    runQuery(env, `SELECT Id, OrderId, Size__c, Color__c, Quantity, Product2.Name FROM OrderItem WHERE OrderId IN (${ids})`),
    runQuery(env, `SELECT Id, Order__c, Name, Packaging_Type__c, Packaging_Quantity__c, ${SIZE_FIELD}, CreatedDate, CreatedBy.Name FROM Order_Packaging__c WHERE Order__c IN (${ids}) ORDER BY CreatedDate ASC`),
  ]);

  const result = orders.map((o) => {
    // Garment lines: one per product + colour, sizes sorted S..XL. Rows with no
    // size are not garments (setup fees, screens) and are left out.
    const groups = new Map();
    for (const it of items) {
      if (it.OrderId !== o.Id || !it.Size__c) continue;
      const product = (it.Product2 && it.Product2.Name) || "Garment";
      const color = it.Color__c || "";
      const key = product + "|" + color;
      if (!groups.has(key)) groups.set(key, { product, color, sizes: new Map() });
      const g = groups.get(key);
      const size = String(it.Size__c).trim();
      g.sizes.set(size, (g.sizes.get(size) || 0) + (Number(it.Quantity) || 0));
    }
    const lines = [...groups.values()].map((g) => {
      const sizes = [...g.sizes.entries()].sort((a, b) => sizeRank(a[0]) - sizeRank(b[0]))
        .map(([size, qty]) => ({ size, qty, boxed: 0 }));
      return { product: g.product, color: g.color, sizes, total: sizes.reduce((a, s) => a + s.qty, 0) };
    });
    // Name = "Garment Type" (e.g. "Tees 2"); Packaging_Quantity__c = the box's total;
    // Quantity_Size_Counted__c = the size breakdown (blank on boxes logged before 10-15).
    const orderBoxes = boxes.filter((b) => b.Order__c === o.Id).map((b) => ({
      id: b.Id, name: b.Name, type: b.Packaging_Type__c || "", qty: Number(b.Packaging_Quantity__c) || 0,
      sizes: b[SIZE_FIELD] || "", counts: parseBreakdown(lines, b[SIZE_FIELD]),
      at: b.CreatedDate, by: (b.CreatedBy && b.CreatedBy.Name) || "",
    }));
    // How many of each size are already in a box (only boxes with a size breakdown count).
    for (const b of orderBoxes) for (const c of b.counts) {
      const s = lines[c.line].sizes.find((x) => x.size === c.size);
      s.boxed += c.qty;
    }
    return {
      id: o.Id,
      num: plainText(o.GOA_Order_Number__c) || o.OrderNumber,
      orderNumber: o.OrderNumber,
      customer: (o.Account && o.Account.Name) || "",
      printDate: o.Print_Date__c || null,
      printer: (o.Printer__r && o.Printer__r.Name) || "",
      specs: plainText(o.Specifications_for_Printing__c).slice(0, 300),
      misprintTotal: Number(o.TotalQtyMisprints__c) || 0,
      misprintDetails: o.Misprint_Details__c || "",
      artworkUrl: o.Artwork_URL__c || null,
      lastModified: o.LastModifiedDate,
      // Still In Production? If not, the crew moved it on before the catcher finished.
      inProduction: o.Order_Substatus__c === "Production",
      status: o.Order_Substatus__c || "",
      finished: o.Packaging_Count__c != null,
      finishedCount: o.Packaging_Count__c != null ? Number(o.Packaging_Count__c) : null,
      lines,
      total: lines.reduce((a, l) => a + l.total, 0),
      boxes: orderBoxes,
    };
  });
  if (!orderId) await writeSeen(env, seen, result);
  // Orders the crew already moved on come first: they're the ones waiting on the catcher.
  return result.sort((a, b) => Number(a.inProduction) - Number(b.inProduction));
}

/** One order, or an error a catcher can understand. Used before every save. */
export async function loadOneOrder(env, orderId) {
  const [order] = await loadOrders(env, { orderId });
  if (!order) {
    throw new SfError("order_not_in_production", 409,
      "This order is no longer on the catching board (it was finished, or isn't In Production), so nothing was saved. Refresh the list.");
  }
  return order;
}
