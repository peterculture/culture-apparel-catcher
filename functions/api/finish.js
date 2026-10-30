/**
 * POST /api/finish   { orderId, requestId }
 *
 * FINISH CATCHING: the catcher is done boxing this order. Writes the number of
 * boxes logged to Order.Packaging_Count__c ("How many boxes are used to package
 * this order?"). Once that is filled in and the order has left In Production,
 * it drops off the board.
 *
 * FULFILLMENT  { orderId, requestId, fulfillment: true }  (added 10-21)
 * A fulfillment order skips boxing: Packaging_Count__c is set to 0, which the app
 * shows as "Fulfillment order. No boxes." Only allowed while the order has no boxes
 * logged, so a real box count is never overwritten with 0.
 *
 * ACTIVATED ORDER (10-30): once the order is activated (Status -> Sent Tracking), Salesforce may
 * refuse the box count ("You don't have permission to edit or delete an activated order"). If the
 * order has also left In Production, the order is let go from the board anyway (its boxes are
 * already saved in Salesforce) and the answer says the count was not written: countSaved: false.
 * The permission "Edit Activated Orders" on Catcher_App_Access lets the count be written instead.
 *
 * Answers 200 only after Salesforce has confirmed the update, or after a release like the above.
 */
import { json, errorResponse, sfFetch, apiVersion, sfMessage, sfErrorCode, SF_ID, SfError } from "./_sf.js";
import { requireUser, REQ_ID, rememberResult, withRequestId } from "./_session.js";
import { loadOneOrder, releaseFromBoard } from "./_orders.js";

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
      const fulfillment = body.fulfillment === true;
      const count = order.boxes.length;
      if (fulfillment && count) {
        return json({ error: "has_boxes", message: `${order.num} has ${count} ${count === 1 ? "box" : "boxes"} logged, so it can't be a fulfillment order. Use FINISH CATCHING, or delete the boxes first.` }, 400);
      }
      if (!fulfillment && !count) return json({ error: "no_boxes", message: "Log at least one box before finishing this order." }, 400);

      const resp = await sfFetch(env, `/services/data/${apiVersion(env)}/sobjects/Order/${order.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ Packaging_Count__c: count }),
      });
      if (resp.status !== 204) {
        const data = await resp.json().catch(() => null);
        console.error("finish save failed", resp.status, sfErrorCode(data), sfMessage(data));
        if (order.activated && !order.inProduction && resp.status >= 400 && resp.status < 500 && !fulfillment
            && await releaseFromBoard(env, order.id)) {
          const released = {
            ok: true, orderId: order.id, boxCount: count, fulfillment, countSaved: false,
            boxed: order.boxes.reduce((a, b) => a + b.qty, 0), total: order.total,
            inProduction: false, by: auth.user.name,
            message: `${order.num} is already activated in Salesforce, so its box count (${count}) couldn't be written` +
              (sfMessage(data) ? ` ("${sfMessage(data)}")` : "") + `. The ${count === 1 ? "box is" : "boxes are"} saved. It's off your board now.`,
          };
          await rememberResult(env, requestId, released);
          return json(released, 200);
        }
        throw new SfError("save_failed", resp.status >= 500 ? 502 : 422,
          "Salesforce did not save the box count" + (sfMessage(data) ? `: "${sfMessage(data)}"` : ".") + " The order stays on the board.");
      }
      const result = {
        ok: true, orderId: order.id, boxCount: count, fulfillment,
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
