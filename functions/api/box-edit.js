/**
 * POST /api/box-edit   { orderId, boxId, type, word, counts: [{ line, size, qty }], requestId }
 *
 * EDIT BOX: changes ONE existing Order_Packaging__c record in place (PATCH) --
 * same record ID, same CreatedDate; no new box is made.
 *   Name (Garment Type)        word + the box's ORIGINAL number, e.g. "Hoodies 3"
 *   Packaging_Type__c          the new Packaging Type
 *   Packaging_Quantity__c      new total, added up here from the size counts
 *   Quantity_Size_Counted__c   new size breakdown
 *
 * The 7-day rule is checked HERE, on a fresh read of the box from Salesforce and
 * this server's clock, so a tablet with a wrong clock or a hidden button can't
 * get round it. The update is sent "only if nobody changed this box since it was
 * read", so two people can't silently overwrite each other.
 */
import { json, errorResponse, sfFetch, apiVersion, picklistValues, sfMessage, sfErrorCode, SF_ID, SfError } from "./_sf.js";
import { requireUser, REQ_ID, rememberResult, withRequestId } from "./_session.js";
import { loadReviewOrder, canChange } from "./_orders.js";
import { boxFields, countsShapeError, checkCounts, garmentWord } from "./_boxes.js";

export async function onRequestPost({ request, env }) {
  const auth = await requireUser(request, env);
  if (auth.response) return auth.response;
  try {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") return json({ error: "bad_request", message: "Nothing was sent." }, 400);
    const orderId = String(body.orderId || ""), boxId = String(body.boxId || ""), requestId = String(body.requestId || "");
    const type = String(body.type || "");
    const word = String(body.word || "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
    if (!SF_ID.test(orderId) || !SF_ID.test(boxId)) return json({ error: "bad_request", message: "That box is not valid. Refresh the list." }, 400);
    if (!REQ_ID.test(requestId)) return json({ error: "bad_request", message: "Refresh the page and try again." }, 400);
    const shape = countsShapeError(body.counts);
    if (shape) return json({ error: "bad_counts", message: shape }, 400);
    if (!word || /\d+$/.test(word)) return json({ error: "bad_word", message: "Pick a Garment Type." }, 400);

    return await withRequestId(env, requestId, 200, async () => {
      const order = await loadReviewOrder(env, orderId);
      const box = order.boxes.find((b) => b.id === boxId);
      if (!box) return json({ error: "box_not_found", message: "That box isn't in Salesforce any more (it may have been deleted). Refresh the list." }, 404);
      if (!canChange(box)) return expired(box);

      const types = await picklistValues(env, "Order_Packaging__c", "Packaging_Type__c");
      if (!types.some((t) => t.value === type)) return json({ error: "bad_type", message: "Pick a Packaging Type from the list." }, 400);
      const checked = checkCounts(order, body.counts);
      if (checked.error) return json({ error: checked.error, message: checked.message }, 400);

      const num = (String(box.name).match(/\s(\d+)$/) || [])[1];
      const name = num ? `${word} ${num}` : word;
      const fields = boxFields({ orderId: order.id, name, type, qty: checked.qty, breakdown: checked.breakdown });
      delete fields.Order__c;                              // the box stays on its order

      const resp = await sfFetch(env, `/services/data/${apiVersion(env)}/sobjects/Order_Packaging__c/${box.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "If-Unmodified-Since": new Date(box.lastModified).toUTCString() },
        body: JSON.stringify(fields),
      });
      if (resp.status === 412) {
        return json({ error: "changed", message: "Someone changed this box a moment ago, so your edit wasn't saved. Close, check the box, and edit again." }, 409);
      }
      if (resp.status === 404) {
        return json({ error: "box_not_found", message: "That box isn't in Salesforce any more (it may have been deleted). Refresh the list." }, 404);
      }
      if (resp.status !== 204) {
        const data = await resp.json().catch(() => null);
        console.error("box edit failed", resp.status, sfErrorCode(data), sfMessage(data));
        throw new SfError("save_failed", resp.status >= 500 ? 502 : 422,
          "Salesforce did not save the change" + (sfMessage(data) ? `: "${sfMessage(data)}"` : ".") + " The box is as it was.");
      }
      const result = { ok: true, orderId: order.id,
        box: Object.assign({}, box, { name, type, qty: checked.qty, sizes: checked.breakdown, counts: checked.clean, lastModified: new Date().toISOString() }),
        before: { name: box.name, type: box.type, qty: box.qty, sizes: box.sizes } };
      await rememberResult(env, requestId, result);
      return json(result, 200);
    });
  } catch (err) {
    return errorResponse(err);
  }
}

export function expired(box) {
  const until = new Date(Date.parse(box.at) + 7 * 24 * 3600 * 1000);
  return json({ error: "review_expired",
    message: `The 7-day review period for “${box.name}” ended ${until.toLocaleString("en-US", { timeZone: "America/Chicago", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}. It can be viewed but not changed. Nothing was saved.` }, 403);
}
