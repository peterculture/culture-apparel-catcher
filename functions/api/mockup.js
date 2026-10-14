/**
 * GET /api/mockup?orderId=...
 * The mockup picture for one In Production screen-print order.
 */
import { json, errorResponse, SF_ID } from "./_sf.js";
import { requireUser } from "./_session.js";
import { loadOneOrder } from "./_orders.js";
import { mockupUrlsFor, fetchMockup } from "./_mockup.js";

export async function onRequestGet({ request, env }) {
  const auth = await requireUser(request, env);
  if (auth.response) return auth.response;
  try {
    const orderId = new URL(request.url).searchParams.get("orderId") || "";
    if (!SF_ID.test(orderId)) return json({ error: "bad_order_id", message: "That order link is not valid." }, 400);
    const order = await loadOneOrder(env, orderId);
    const urls = await mockupUrlsFor(env, [order]);
    const raw = urls.get(order.id);
    if (!raw) return json({ error: "no_mockup", message: "This order has no mockup in Salesforce." }, 404);
    const resp = await fetchMockup(env, raw);
    return resp || json({ error: "mockup_unavailable", message: "The mockup could not be loaded." }, 502);
  } catch (err) {
    return errorResponse(err);
  }
}
