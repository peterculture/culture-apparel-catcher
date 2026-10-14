/**
 * POST /api/boxes   { orderId, type, qty, name, requestId }
 *
 * Logs ONE packed box: creates one Order_Packaging__c record, exactly what the
 * "Enter Packaging" flow (V3) creates today:
 *   Name                   e.g. "Tees 3"  (what is in the box, and its number)
 *   Order__c               the order
 *   Packaging_Type__c      the box used
 *   Packaging_Quantity__c  how many garments are in this box
 * Number of boxes = number of these records.
 *
 * Answers 201 only after Salesforce has confirmed the record exists.
 */
import { json, errorResponse, sfFetch, apiVersion, picklistValues, sfMessage, sfErrorCode, SF_ID, SfError } from "./_sf.js";
import { requireUser, REQ_ID, rememberResult, withRequestId } from "./_session.js";
import { loadOneOrder } from "./_orders.js";

export async function onRequestPost({ request, env }) {
  const auth = await requireUser(request, env);
  if (auth.response) return auth.response;
  try {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") return json({ error: "bad_request", message: "Nothing was sent." }, 400);

    const orderId = String(body.orderId || "");
    const type = String(body.type || "");
    const qty = Number(body.qty);
    const name = String(body.name || "").replace(/\s+/g, " ").trim().slice(0, 80);
    const requestId = String(body.requestId || "");

    if (!SF_ID.test(orderId)) return json({ error: "bad_order_id", message: "That order is not valid. Refresh the list." }, 400);
    if (!Number.isInteger(qty) || qty < 1 || qty > 9999) return json({ error: "bad_qty", message: "Enter how many garments are in the box (1 to 9999)." }, 400);
    if (!REQ_ID.test(requestId)) return json({ error: "bad_request", message: "Refresh the page and try again." }, 400);

    return await withRequestId(env, requestId, 201, async () => {
    const types = await picklistValues(env, "Order_Packaging__c", "Packaging_Type__c");
    if (!types.some((t) => t.value === type)) {
      return json({ error: "bad_type", message: "Pick a box type from the list." }, 400);
    }

    // The order must still be one the catchers are allowed to see.
    const order = await loadOneOrder(env, orderId);
    const boxName = name || `${type} ${order.boxes.length + 1}`;

    const resp = await sfFetch(env, `/services/data/${apiVersion(env)}/sobjects/Order_Packaging__c`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        Name: boxName,
        Order__c: order.id,
        Packaging_Type__c: type,
        Packaging_Quantity__c: qty,
      }),
    });
    const data = await resp.json().catch(() => null);
    if (resp.status !== 201 || !data || !data.id || data.success === false) {
      console.error("box create failed", resp.status, sfErrorCode(data), sfMessage(data));
      throw new SfError("save_failed", resp.status >= 500 ? 502 : 422,
        "Salesforce did not save the box" + (sfMessage(data) ? `: "${sfMessage(data)}"` : ".") + " Nothing was saved.");
    }

    const result = {
      ok: true,
      box: { id: data.id, name: boxName, type, qty, by: auth.user.name, at: new Date().toISOString() },
      orderId: order.id,
      boxCount: order.boxes.length + 1,
      boxed: order.boxes.reduce((a, b) => a + b.qty, 0) + qty,
    };
    await rememberResult(env, requestId, result);
    return json(result, 201);
    });
  } catch (err) {
    return errorResponse(err);
  }
}
