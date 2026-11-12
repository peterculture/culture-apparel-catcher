/**
 * POST /api/box-delete-many   { orderId, boxIds: [..], requestId }
 *
 * SELECT + DELETE (11-02): the catcher ticks several boxes under "Boxes on this order" and deletes
 * them together. Same rules as DELETE BOX (box-delete.js), for every box:
 *   - every box must still be on that order in Salesforce, on a fresh read;
 *   - every box must still be inside its 7-day review window, on THIS server's clock;
 *   if any one fails, NOTHING is deleted and the answer names the box.
 * Deleted ALL OR NOTHING in one Salesforce call (composite/sobjects DELETE, allOrNone=true), so a
 * catcher never ends up with half of the boxes gone. Salesforce puts them in the Recycle Bin, where an
 * admin can restore them for 15 days. A finished order's Packaging Count is set to the new number
 * of boxes, as with a single delete.
 */
import { json, errorResponse, sfFetch, apiVersion, sfMessage, sfErrorCode, SF_ID, SfError, orgFor } from "./_sf.js";
import { requireUser, REQ_ID, rememberResult, withRequestId } from "./_session.js";
import { loadReviewOrder, canChange } from "./_orders.js";
import { expired } from "./box-edit.js";
import { forgeAfterDelete } from "./_forge.js";

export const MAX_DELETE = 100;

export async function onRequestPost({ request, env: siteEnv }) {
  // Which Salesforce org this request uses, fixed for the whole request (11-12, see _sf.js).
  const org = await orgFor(request, siteEnv);
  if (org.response) return org.response;
  const env = org.env;
  const auth = await requireUser(request, env);
  if (auth.response) return auth.response;
  try {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") return json({ error: "bad_request", message: "Nothing was sent." }, 400);
    const orderId = String(body.orderId || ""), requestId = String(body.requestId || "");
    const raw = Array.isArray(body.boxIds) ? body.boxIds.map(String) : [];
    const boxIds = [...new Set(raw)];
    if (!SF_ID.test(orderId) || !boxIds.length || !boxIds.every((id) => SF_ID.test(id))) {
      return json({ error: "bad_request", message: "Those boxes are not valid. Refresh the list." }, 400);
    }
    if (boxIds.length > MAX_DELETE) return json({ error: "too_many", message: `The most is ${MAX_DELETE} boxes at a time.` }, 400);
    if (!REQ_ID.test(requestId)) return json({ error: "bad_request", message: "Refresh the page and try again." }, 400);

    return await withRequestId(env, requestId, 200, async () => {
      const order = await loadReviewOrder(env, orderId);
      const boxes = [];
      for (const id of boxIds) {
        const box = order.boxes.find((b) => b.id === id);
        if (!box) return json({ error: "box_not_found", message: "One of the ticked boxes isn't in Salesforce any more (it may already be deleted). Nothing was deleted. Refresh the list." }, 404);
        if (!canChange(box)) return expired(box);
        boxes.push(box);
      }

      const path = `/services/data/${apiVersion(env)}/composite/sobjects?allOrNone=true&ids=${boxes.map((b) => b.id).join(",")}`;
      const resp = await sfFetch(env, path, { method: "DELETE" });
      const data = await resp.json().catch(() => null);
      const rows = Array.isArray(data) ? data : [];
      const allOk = resp.ok && rows.length === boxes.length && rows.every((r) => r && r.success);
      if (!allOk) {
        const err = rows.map((r) => r && r.errors && r.errors[0]).find((e) => e && e.message && e.statusCode !== "ALL_OR_NONE_OPERATION_ROLLED_BACK")
          || (Array.isArray(data) && data[0] && !("success" in data[0]) ? data[0] : null);
        const msg = err ? err.message : sfMessage(data);
        console.error("box delete-many failed", resp.status, err ? err.statusCode || err.errorCode : sfErrorCode(data), msg);
        throw new SfError("delete_failed", resp.status >= 500 ? 502 : 422,
          "Salesforce did not delete the boxes" + (msg ? `: "${String(msg).slice(0, 300)}"` : ".") + " None were deleted; they are all still there.");
      }

      // Keep a finished order's Packaging Count true. The boxes ARE deleted either way.
      let countNote = "";
      const left = order.boxes.length - boxes.length;
      if (order.finished && order.finishedCount !== left) {
        const r2 = await sfFetch(env, `/services/data/${apiVersion(env)}/sobjects/Order/${order.id}`, {
          method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ Packaging_Count__c: left }),
        }).catch(() => null);
        countNote = r2 && r2.status === 204 ? `Packaging Count on the order is now ${left}.`
          : `The boxes are deleted, but the order's Packaging Count still says ${order.finishedCount}. Tell a manager to set it to ${left}.`;
        if (!(r2 && r2.status === 204)) console.error("packaging count update after delete-many failed", r2 && r2.status);
      }
      const result = { ok: true, orderId: order.id, deleted: boxes.map((b) => ({ id: b.id, name: b.name, type: b.type, qty: b.qty, sizes: b.sizes })),
        boxCount: left, countNote, forgeNote: await forgeAfterDelete(env, boxes.map((b) => b.id)) };
      await rememberResult(env, requestId, result);
      return json(result, 200);
    });
  } catch (err) {
    return errorResponse(err);
  }
}
