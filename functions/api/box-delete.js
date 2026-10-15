/**
 * POST /api/box-delete   { orderId, boxId, requestId }
 *
 * DELETE BOX: deletes ONE Order_Packaging__c record, the same way the production
 * dashboard's existing "undo a mis-logged package" does (REST DELETE). Salesforce
 * puts it in the Recycle Bin, where an admin can restore it for 15 days.
 *
 * The 7-day rule is checked HERE on a fresh read and this server's clock.
 * If the order was already marked finished (Packaging Count filled in by FINISH
 * CATCHING), that count is set to the new number of boxes so it stays true.
 */
import { json, errorResponse, sfFetch, apiVersion, sfMessage, sfErrorCode, SF_ID, SfError } from "./_sf.js";
import { requireUser, REQ_ID, rememberResult, withRequestId } from "./_session.js";
import { loadReviewOrder, canChange } from "./_orders.js";
import { expired } from "./box-edit.js";

export async function onRequestPost({ request, env }) {
  const auth = await requireUser(request, env);
  if (auth.response) return auth.response;
  try {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") return json({ error: "bad_request", message: "Nothing was sent." }, 400);
    const orderId = String(body.orderId || ""), boxId = String(body.boxId || ""), requestId = String(body.requestId || "");
    if (!SF_ID.test(orderId) || !SF_ID.test(boxId)) return json({ error: "bad_request", message: "That box is not valid. Refresh the list." }, 400);
    if (!REQ_ID.test(requestId)) return json({ error: "bad_request", message: "Refresh the page and try again." }, 400);

    return await withRequestId(env, requestId, 200, async () => {
      const order = await loadReviewOrder(env, orderId);
      const box = order.boxes.find((b) => b.id === boxId);
      if (!box) return json({ error: "box_not_found", message: "That box isn't in Salesforce any more (it may already be deleted). Refresh the list." }, 404);
      if (!canChange(box)) return expired(box);

      const resp = await sfFetch(env, `/services/data/${apiVersion(env)}/sobjects/Order_Packaging__c/${box.id}`, { method: "DELETE" });
      if (resp.status !== 204) {
        const data = await resp.json().catch(() => null);
        console.error("box delete failed", resp.status, sfErrorCode(data), sfMessage(data));
        throw new SfError("delete_failed", resp.status >= 500 ? 502 : 422,
          "Salesforce did not delete the box" + (sfMessage(data) ? `: "${sfMessage(data)}"` : ".") + " It is still there.");
      }

      // Keep a finished order's Packaging Count true. The box IS deleted either way.
      let countNote = "";
      const left = order.boxes.length - 1;
      if (order.finished && order.finishedCount !== left) {
        const r2 = await sfFetch(env, `/services/data/${apiVersion(env)}/sobjects/Order/${order.id}`, {
          method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ Packaging_Count__c: left }),
        }).catch(() => null);
        countNote = r2 && r2.status === 204 ? `Packaging Count on the order is now ${left}.`
          : `The box is deleted, but the order's Packaging Count still says ${order.finishedCount}. Tell a manager to set it to ${left}.`;
        if (!(r2 && r2.status === 204)) console.error("packaging count update after delete failed", r2 && r2.status);
      }
      const result = { ok: true, orderId: order.id, deleted: { id: box.id, name: box.name, type: box.type, qty: box.qty, sizes: box.sizes }, boxCount: left, countNote };
      await rememberResult(env, requestId, result);
      return json(result, 200);
    });
  } catch (err) {
    return errorResponse(err);
  }
}
