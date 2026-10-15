/**
 * POST /api/duplicate-box   { orderId, boxId, count, requestId }
 *
 * DUPLICATE BOX: makes `count` (1-100) NEW box records that copy one saved box's
 * Packaging Type, total (Packaging Quantity) and complete size breakdown
 * (Quantity + Size Counted). Each copy gets its own Salesforce record ID and the
 * next box number for its Garment Type ("Tees 3" -> "Tees 4", "Tees 5", ...).
 * The original box is only read, never changed.
 *
 * Safety:
 *  - All copies go to Salesforce in ONE request with allOrNone = true: either
 *    every copy is created, or none are. A half-finished batch can't happen.
 *  - The request id makes a double tap or a retry return the first answer
 *    instead of creating the copies twice.
 *  - If Salesforce doesn't answer in time, the answer is "not sure" (never
 *    "saved", never "failed") and that same request can't be re-run for
 *    2 minutes -- the tablet reloads the order so the catcher can see.
 *  - Only boxes Salesforce confirms are reported as created.
 */
import { json, errorResponse, sfFetch, apiVersion, picklistValues, sfMessage, SF_ID, SfError } from "./_sf.js";
import { requireUser, REQ_ID, rememberResult, withRequestId } from "./_session.js";
import { loadOneOrder } from "./_orders.js";
import { boxFields, garmentWord, nextNames } from "./_boxes.js";

export const MAX_DUPLICATES = 100;

export async function onRequestPost({ request, env }) {
  const auth = await requireUser(request, env);
  if (auth.response) return auth.response;
  try {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") return json({ error: "bad_request", message: "Nothing was sent." }, 400);
    const orderId = String(body.orderId || "");
    const boxId = String(body.boxId || "");
    const count = body.count;
    const requestId = String(body.requestId || "");
    if (!SF_ID.test(orderId) || !SF_ID.test(boxId)) return json({ error: "bad_request", message: "That box is not valid. Refresh the list." }, 400);
    if (!Number.isInteger(count) || count < 1 || count > MAX_DUPLICATES) {
      return json({ error: "bad_count", message: `Enter a whole number from 1 to ${MAX_DUPLICATES}.` }, 400);
    }
    if (!REQ_ID.test(requestId)) return json({ error: "bad_request", message: "Refresh the page and try again." }, 400);

    return await withRequestId(env, requestId, 201, async () => {
      // Fresh read: the order must still be on the board, and the box must be on THIS order.
      const order = await loadOneOrder(env, orderId);
      const src = order.boxes.find((b) => b.id === boxId);
      if (!src) return json({ error: "box_not_found", message: "That box isn't on this order any more. Refresh the list." }, 409);
      if (!(src.qty >= 1)) return json({ error: "bad_source", message: "That box has no garment count, so it can't be copied." }, 422);
      const types = await picklistValues(env, "Order_Packaging__c", "Packaging_Type__c");
      if (!types.some((t) => t.value === src.type)) {
        return json({ error: "bad_type", message: `"${src.type}" is no longer a Packaging Type you can pick, so nothing was copied.` }, 422);
      }

      const word = garmentWord(src.name);
      const names = nextNames(order.boxes, word, count);
      const records = names.map((name) => Object.assign({ attributes: { type: "Order_Packaging__c" } },
        boxFields({ orderId: order.id, name, type: src.type, qty: src.qty, breakdown: src.sizes })));

      const resp = await sfFetch(env, `/services/data/${apiVersion(env)}/composite/sobjects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ allOrNone: true, records }),
      });
      const data = await resp.json().catch(() => null);
      const results = Array.isArray(data) ? data : [];
      const created = [];
      results.forEach((r, i) => { if (r && r.success && r.id && SF_ID.test(r.id)) created.push({ id: r.id, name: names[i] }); });

      if (resp.status !== 200 || created.length !== count) {
        const firstErr = results.map((r) => r && r.errors && r.errors[0]).find((e) => e && e.message && e.statusCode !== "ALL_OR_NONE_OPERATION_ROLLED_BACK")
          || (Array.isArray(data) ? null : data && data[0]) || null;
        const why = (firstErr && firstErr.message) || sfMessage(data) || "";
        console.error("duplicate failed", resp.status, created.length, "of", count, why);
        if (created.length) {
          // Shouldn't happen with allOrNone, but if Salesforce ever reports it, say exactly what exists.
          const partial = { ok: false, error: "partial", created: created.length, failed: count - created.length,
            boxes: created.map((c) => box(c, src, auth)), message: `${created.length} of ${count} copies were created; ${count - created.length} were not` + (why ? `: "${why}"` : ".") + " Nothing was retried." };
          await rememberResult(env, requestId, partial);
          return json(partial, 207);
        }
        throw new SfError("save_failed", resp.status >= 500 ? 502 : 422,
          "Salesforce did not create the copies" + (why ? `: "${why}"` : ".") + ` None of the ${count} were created.`);
      }

      const result = { ok: true, created: count, failed: 0, sourceId: src.id, boxes: created.map((c) => box(c, src, auth)) };
      await rememberResult(env, requestId, result);
      return json(result, 201);
    });
  } catch (err) {
    return errorResponse(err);
  }
}

function box(c, src, auth) {
  return { id: c.id, name: c.name, type: src.type, qty: src.qty, sizes: src.sizes || "", counts: src.counts || [], by: auth.user.name, at: new Date().toISOString() };
}
