/**
 * POST /api/finish   { orderId, requestId }
 *
 * FINISH CATCHING: the catcher is done boxing this order. Writes the number of
 * boxes logged to Order.Packaging_Count__c ("How many boxes are used to package
 * this order?"). Once that is filled in and the order has left In Production,
 * it drops off the board.
 *
 * Answers 200 only after Salesforce has confirmed the update.
 */
import { json, errorResponse, sfFetch, apiVersion, sfMessage, sfErrorCode, SF_ID, SfError } from "./_sf.js";
import { requireUser, REQ_ID, rememberResult, withRequestId } from "./_session.js";
import { loadOneOrder } from "./_orders.js";

export async function onRequestPost({ request, env }) {
  const auth = await requireUser(request, env);
  if (auth.response) return auth.response;
  try {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") return json({ error: "bad_request", message: "Nothing was sent." }, 400);
    const orderId = String(body.orderId || "");
    const requestId = String(body.requestId || "");
    if (!SF_ID.test(orderId)) return json({ error: "bad_order_id", message: "That order is not valid. Refresh the list." }, 400);
    if (!REQ_ID.test(requestId)) return json({ error: "bad_request", message: "Refresh the page and try again." }, 400);

    return await withRequestId(env, requestId, 200, async () => {
      const order = await loadOneOrder(env, orderId);
      const count = order.boxes.length;
      if (!count) return json({ error: "no_boxes", message: "Log at least one box before finishing this order." }, 400);

      const resp = await sfFetch(env, `/services/data/${apiVersion(env)}/sobjects/Order/${order.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ Packaging_Count__c: count }),
      });
      if (resp.status !== 204) {
        const data = await resp.json().catch(() => null);
        console.error("finish save failed", resp.status, sfErrorCode(data), sfMessage(data));
        throw new SfError("save_failed", resp.status >= 500 ? 502 : 422,
          "Salesforce did not save the box count" + (sfMessage(data) ? `: "${sfMessage(data)}"` : ".") + " The order stays on the board.");
      }
      const result = {
        ok: true, orderId: order.id, boxCount: count,
        boxed: order.boxes.reduce((a, b) => a + b.qty, 0), total: order.total,
        inProduction: order.inProduction, by: auth.user.name,
      };
      await rememberResult(env, requestId, result);
      return json(result, 200);
    });
  } catch (err) {
    return errorResponse(err);
  }
}
