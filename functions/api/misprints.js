/**
 * POST /api/misprints  { orderId, qty, size, garment, reason, note, requestId }
 *
 * Records a misprint on the ORDER, the way the shop records them today:
 *   TotalQtyMisprints__c  += qty
 *   Misprint_Details__c   gets one more line, under the "TOTAL QTY: NN" heading
 *
 * Why keep the "TOTAL QTY: NN" heading: the formula field Total_Quantity_Misprints__c
 * and the misprint-rate reports read the number at characters 11-13 of
 * Misprint Details. Writing it in that shape keeps them correct.
 *
 * Changing Misprint Details sets off the "Printshop Misprint Process" flow,
 * which notifies the print shop. That is wanted.
 *
 * Two catchers saving on the same order at once can't overwrite each other:
 * the update is sent "only if nobody changed the order since I read it", and
 * re-read and retried if somebody did.
 */
import { json, errorResponse, sfFetch, apiVersion, sfMessage, sfErrorCode, SF_ID, SfError } from "./_sf.js";
import { requireUser, REQ_ID, rememberResult, withRequestId } from "./_session.js";
import { loadOneOrder } from "./_orders.js";

export const REASONS = ["Stained", "Off-center", "Crooked", "Ink smear", "Wrong color", "Burned", "Hole / damaged", "Other"];
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

/** "TOTAL QTY: 07" -- the number always lands at characters 11-13. */
export function totalHeading(total) {
  const n = Math.max(0, Math.min(TOTAL_MAX, total));
  return n < 100 ? `TOTAL QTY: ${String(n).padStart(2, "0")}` : `TOTAL QTY:${n}`;
}

/** Existing Misprint Details minus its heading (whatever people typed stays). */
export function existingNotes(details) {
  return String(details || "").replace(/^\s*TOTAL QTY:\s*\d{0,3}\s*/i, "").trim();
}

/** The new Misprint Details text, or null if it can't fit in 255 characters. */
export function buildDetails(existing, total, parts) {
  const { qty, size, garment, reason, note, who, date } = parts;
  const base = `${qty} ${size}${garment ? " " + garment : ""} - ${reason}`;
  const tries = [
    `${base}${note ? ": " + note : ""} (${who} ${date})`,
    `${base} (${who} ${date})`,
    `${base} (${date})`,
  ];
  const before = existingNotes(existing);
  for (const line of tries) {
    const text = `${totalHeading(total)} ${before ? before + " | " : ""}${line}`;
    if (text.length <= DETAILS_MAX) return text;
  }
  return null;
}

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

    if (!SF_ID.test(orderId)) return json({ error: "bad_order_id", message: "That order is not valid. Refresh the list." }, 400);
    if (!Number.isInteger(qty) || qty < 1 || qty > 99) return json({ error: "bad_qty", message: "Enter how many were misprinted (1 to 99)." }, 400);
    if (!size) return json({ error: "bad_size", message: "Pick a size." }, 400);
    if (!REASONS.includes(reason)) return json({ error: "bad_reason", message: "Pick what went wrong." }, 400);
    if (!REQ_ID.test(requestId)) return json({ error: "bad_request", message: "Refresh the page and try again." }, 400);

    return await withRequestId(env, requestId, 200, async () => {
    const who = auth.user.name;
    const date = shopDate();

    for (let attempt = 0; attempt < 3; attempt++) {
      const order = await loadOneOrder(env, orderId);
      const lineSizes = new Set(order.lines.flatMap((l) => l.sizes.map((s) => s.size)));
      if (lineSizes.size && !lineSizes.has(size)) {
        return json({ error: "bad_size", message: `This order has no size ${size}. Pick a size from the list.` }, 400);
      }
      const newTotal = order.misprintTotal + qty;
      if (newTotal > TOTAL_MAX) {
        return json({ error: "too_many", message: "This order already has a very high misprint count. Tell a manager." }, 422);
      }
      const details = buildDetails(order.misprintDetails, newTotal, { qty, size, garment, reason, note, who, date });
      if (!details) {
        return json({ error: "details_full", message: "The order's misprint notes are full, so nothing was saved. Tell a manager to tidy Misprint Details." }, 422);
      }

      const resp = await sfFetch(env, `/services/data/${apiVersion(env)}/sobjects/Order/${order.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "If-Unmodified-Since": new Date(order.lastModified).toUTCString(),
        },
        body: JSON.stringify({ TotalQtyMisprints__c: newTotal, Misprint_Details__c: details }),
      });
      if (resp.status === 412) continue; // someone changed the order a moment ago: read again, add on top
      if (resp.status !== 204) {
        const data = await resp.json().catch(() => null);
        console.error("misprint save failed", resp.status, sfErrorCode(data), sfMessage(data));
        throw new SfError("save_failed", resp.status >= 500 ? 502 : 422,
          "Salesforce did not save the misprint" + (sfMessage(data) ? `: "${sfMessage(data)}"` : ".") + " Nothing was saved.");
      }
      const result = {
        ok: true,
        misprint: { qty, size, garment, reason, note, by: who, at: new Date().toISOString() },
        orderId: order.id,
        misprintTotal: newTotal,
      };
      await rememberResult(env, requestId, result);
      return json(result, 200);
    }
    throw new SfError("busy", 409, "This order kept changing while saving, so nothing was saved. Try again.");
    });
  } catch (err) {
    return errorResponse(err);
  }
}
