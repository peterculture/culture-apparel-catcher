/**
 * GET /api/mockup?orderId=...
 * The mockup picture for one In Production screen-print order.
 *
 * The picture is kept in Cloudflare's cache for 10 minutes, keyed by order, so
 * once ONE download has FINISHED every tablet gets it from the cache. Only a
 * signed-in catcher can read it, and an order only gets into the cache after
 * passing the In Production check.
 *
 * A download still in progress is never shared between requests (The Forge rule,
 * 2026-10-29): a cancelled request would leave everyone waiting on it. On one
 * tablet the small card and the big picture already share one download.
 */
import { json, errorResponse, SF_ID } from "./_sf.js";
import { requireUser } from "./_session.js";
import { loadOneOrder } from "./_orders.js";
import { mockupUrlsFor, mockupFilesFor, fetchMockup, fetchFileMockup } from "./_mockup.js";

const CACHE_SECONDS = 600;

// The answer and the cache each get their OWN copy of the bytes: on Cloudflare a
// body handed to one Response can't be used again.
function pictureResponse(pic) {
  return new Response(pic.bytes.slice(0), {
    headers: { "Content-Type": pic.type, "Cache-Control": "private, max-age=300", "X-Content-Type-Options": "nosniff" },
  });
}

export async function onRequestGet({ request, env, waitUntil }) {
  const auth = await requireUser(request, env);
  if (auth.response) return auth.response;
  try {
    const params = new URL(request.url).searchParams;
    const orderId = params.get("orderId") || "";
    if (!SF_ID.test(orderId)) return json({ error: "bad_order_id", message: "That order link is not valid." }, 400);
    const n = Math.min(5, Math.max(0, parseInt(params.get("n") || "0", 10) || 0));  // which picture (0 = newest)

    const cache = typeof caches !== "undefined" ? caches.default : null;
    const key = new Request(`https://mockup-cache.internal/${orderId}/${n}`);
    if (cache) {
      const hit = await cache.match(key);
      if (hit) {
        return new Response(hit.body, { headers: {
          "Content-Type": hit.headers.get("Content-Type") || "application/octet-stream",
          "Cache-Control": "private, max-age=300", "X-Content-Type-Options": "nosniff" } });
      }
    }

    const pic = await (async () => {
      const order = await loadOneOrder(env, orderId);
      const files = (await mockupFilesFor(env, [order])).get(order.id) || [];
      if (files.length) return files[n] ? fetchFileMockup(env, files[n].cv) : { none: true };
      const raw = n === 0 ? (await mockupUrlsFor(env, [order])).get(order.id) : null;
      if (!raw) return { none: true };
      return fetchMockup(env, raw);
    })();
    if (pic && pic.none) return json({ error: "no_mockup", message: "This order has no mockup in Salesforce." }, 404);
    if (!pic) return json({ error: "mockup_unavailable", message: "The mockup could not be loaded." }, 502);

    if (cache) {
      const put = cache.put(key, new Response(pic.bytes.slice(0), {
        headers: { "Content-Type": pic.type, "Cache-Control": `public, max-age=${CACHE_SECONDS}` } }));
      if (waitUntil) waitUntil(put); else await put;
    }
    return pictureResponse(pic);
  } catch (err) {
    return errorResponse(err);
  }
}
