/**
 * POST /api/misprints  { orderId, line, qty, size, garment, reason, note, requestId }
 *
 * Records a misprint on the ORIGINAL order, in ONE all-or-nothing Salesforce request:
 *   Order      TotalQtyMisprints__c  += qty
 *              Misprint_Details__c   gets one more line ("2 XL Navy Gildan - Stained (Maria 10/27)")
 *   OrderItem  the matching size line of that garment:
 *              Damaged_Quantity__c  += qty   when the reason is "Hole / damaged"
 *              Misprint_Quantity__c += qty   for every other reason
 *
 * Why the order line (Anthony, 2026-10-27): the Production Error button runs the flow
 * "SCREEN Order Reprint Process2". Its first screen is a table of this order's lines with
 * "# Misprinted" and "# Damaged" columns that show exactly these two fields. With the
 * catcher's counts stored here, the press operator only confirms or corrects them.
 * Written after each save (not at Finish Catching).
 *
 * An extra size ("Add More") isn't a line on the order: it goes in the notes only.
 * Order lines can't be changed once Salesforce has activated the order (around Sent
 * Tracking); then nothing is saved and the catcher is told why.
 *
 * The old "TOTAL QTY: NN" heading is no longer written (decided 2026-10-27): the reprint
 * flow replaces Misprint Details with what the operator types anyway. An old heading
 * still in the field is dropped the next time a line is added.
 *
 * Changing Misprint Details sets off the "Printshop Misprint Process" flow, which
 * notifies the print shop. That is wanted.
 *
 * Two catchers saving on the same order at once can't overwrite each other: both
 * records are sent "only if nobody changed them since they were read", and the
 * whole save is re-read and retried if somebody did.
 */
import { json, errorResponse, sfFetch, apiVersion, sfMessage, SF_ID, SfError } from "./_sf.js";
import { requireUser, REQ_ID, rememberResult, withRequestId } from "./_session.js";
import { loadOneOrder } from "./_orders.js";

export const REASONS = ["Stained", "Off-center", "Crooked", "Ink smear", "Wrong color", "Burned", "Hole / damaged", "Other"];
export const DAMAGED_REASON = "Hole / damaged";
const DETAILS_MAX = 255;
const TOTAL_MAX = 999;

function clean(s, max) {
  return String(s == null ? "" : s).replace(/[\r\n\t|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function shopDate(d = new Date()) {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", month: "numeric", day: "numeric" }).format(d);
  } catch (_) { return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`; }
}

/** Existing Misprint Details, without an old "TOTAL QTY: NN" heading (whatever people typed stays). */
export function existingNotes(details) {
  return String(details || "").replace(/^\s*TOTAL QTY:\s*\d{0,3}\s*/i, "").trim();
}

/** The new Misprint Details text, or null if it can't fit in 255 characters. */
export function buildDetails(existing, parts) {
  const { qty, size, garment, reason, note, who, date } = parts;
  const base = `${qty} ${size}${garment ? " " + garment : ""} - ${reason}`;
  const tries = [
    `${base}${note ? ": " + note : ""} (${who} ${date})`,
    `${base} (${who} ${date})`,
    `${base} (${date})`,
  ];
  const before = existingNotes(existing);
  for (const line of tries) {
    const text = `${before ? before + " | " : ""}${line}`;
    if (text.length <= DETAILS_MAX) return text;
  }
  return null;
}

/** "Navy Gildan 5000 Tee" -- how the tablet names a garment (colour + product, 40 characters). */
function garmentName(l) { return ((l.color ? l.color + " " : "") + (l.product || "")).trim().slice(0, 40); }

/** The garment line the misprint is on: by the tablet's line number, else by name, else the only one. */
export function findLine(order, lineIdx, garment) {
  if (Number.isInteger(lineIdx) && order.lines[lineIdx]) return order.lines[lineIdx];
  const byName = order.lines.filter((l) => garmentName(l) === garment);
  if (byName.length === 1) return byName[0];
  return order.lines.length === 1 ? order.lines[0] : null;
}

const HTTP_DATE = (iso) => new Date(iso).toUTCString();

export async function onRequestPost({ request, env }) {
  const auth = await requireUser(request, env);
  if (auth.response) return auth.response;
  try {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") return json({ error: "bad_request", message: "Nothing was sent." }, 400);

    const orderId = String(body.orderId || "");
    const qty = Number(body.qty);
    const size = clean(body.size, 10);
    const garment = clean(body.garment, 40);
    const reason = String(body.reason || "");
    const note = clean(body.note, 80);
    const requestId = String(body.requestId || "");
    const lineIdx = body.line === undefined || body.line === null ? null : body.line;

    if (!SF_ID.test(orderId)) return json({ error: "bad_order_id", message: "That order is not valid. Refresh the list." }, 400);
    if (!Number.isInteger(qty) || qty < 1 || qty > 99) return json({ error: "bad_qty", message: "Enter how many were misprinted (1 to 99)." }, 400);
    if (!size) return json({ error: "bad_size", message: "Pick a size." }, 400);
    if (!REASONS.includes(reason)) return json({ error: "bad_reason", message: "Pick what went wrong." }, 400);
    if (lineIdx !== null && !Number.isInteger(lineIdx)) return json({ error: "bad_request", message: "Refresh the page and try again." }, 400);
    if (!REQ_ID.test(requestId)) return json({ error: "bad_request", message: "Refresh the page and try again." }, 400);

    return await withRequestId(env, requestId, 200, async () => {
    const who = auth.user.name;
    const date = shopDate();
    const damaged = reason === DAMAGED_REASON;
    const field = damaged ? "Damaged_Quantity__c" : "Misprint_Quantity__c";
    const v = apiVersion(env);

    for (let attempt = 0; attempt < 3; attempt++) {
      const order = await loadOneOrder(env, orderId);
      const line = findLine(order, lineIdx, garment);
      const pool = line ? [line] : order.lines;
      const onOrder = pool.some((l) => l.sizes.some((s) => s.size === size));
      const isExtra = !onOrder && pool.some((l) => (l.extras || []).some((e) => e.size === size));
      const anySizes = order.lines.some((l) => l.sizes.length);
      if (anySizes && !onOrder && !isExtra) {
        return json({ error: "bad_size", message: `This order has no size ${size}. Pick a size from the list.` }, 400);
      }
      const newTotal = order.misprintTotal + qty;
      if (newTotal > TOTAL_MAX) {
        return json({ error: "too_many", message: "This order already has a very high misprint count. Tell a manager." }, 422);
      }
      const details = buildDetails(order.misprintDetails, { qty, size, garment, reason, note, who, date });
      if (!details) {
        return json({ error: "details_full", message: "The order's misprint notes are full, so nothing was saved. Tell a manager to tidy Misprint Details." }, 422);
      }

      // The Salesforce line for this size (the first, if the order lists the size more than once).
      const cell = line && line.sizes.find((s) => s.size === size);
      const item = cell && cell.items && cell.items[0];

      const subs = [{
        method: "PATCH", url: `/services/data/${v}/sobjects/Order/${order.id}`, referenceId: "order",
        httpHeaders: { "If-Unmodified-Since": HTTP_DATE(order.lastModified) },
        body: { TotalQtyMisprints__c: newTotal, Misprint_Details__c: details },
      }];
      if (item) {
        const sub = { method: "PATCH", url: `/services/data/${v}/sobjects/OrderItem/${item.id}`, referenceId: "line",
          body: { [field]: (damaged ? item.dmg : item.mis) + qty } };
        if (item.lm) sub.httpHeaders = { "If-Unmodified-Since": HTTP_DATE(item.lm) };
        subs.push(sub);
      }

      const resp = await sfFetch(env, `/services/data/${v}/composite`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ allOrNone: true, compositeRequest: subs }),
      });
      const data = await resp.json().catch(() => null);
      const parts = data && Array.isArray(data.compositeResponse) ? data.compositeResponse : null;
      if (resp.status === 200 && parts && parts.length === subs.length && parts.every((p) => p.httpStatusCode >= 200 && p.httpStatusCode < 300)) {
        const result = {
          ok: true,
          misprint: { qty, size, garment, reason, note, by: who, at: new Date().toISOString(),
            // where the count went on the order's lines (null = notes only, e.g. an extra size)
            stored: item ? { field: damaged ? "damaged" : "misprinted", size } : null, extra: isExtra },
          orderId: order.id,
          misprintTotal: newTotal,
        };
        await rememberResult(env, requestId, result);
        return json(result, 200);
      }
      if (parts && parts.some((p) => p.httpStatusCode === 412)) continue; // someone changed it a moment ago: read again, add on top
      const firstErr = parts && parts.map((p) => Array.isArray(p.body) ? p.body[0] : null)
        .find((e) => e && e.message && !/PROCESSING_HALTED|ALL_OR_NONE_OPERATION_ROLLED_BACK/.test(e.errorCode || ""));
      const why = (firstErr && String(firstErr.message).replace(/\s+/g, " ").trim().slice(0, 300)) || sfMessage(data) || "";
      console.error("misprint save failed", resp.status, firstErr && firstErr.errorCode, why);
      throw new SfError("save_failed", resp.status >= 500 ? 502 : 422,
        "Salesforce did not save the misprint" + (why ? `: "${why}"` : ".") + " Nothing was saved.");
    }
    throw new SfError("busy", 409, "This order kept changing while saving, so nothing was saved. Try again.");
    });
  } catch (err) {
    return errorResponse(err);
  }
}
