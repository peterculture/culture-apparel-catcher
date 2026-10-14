/**
 * GET /api/mockup?orderId=...
 * The mockup picture for one In Production screen-print order.
 *
 * The picture is kept in Cloudflare's cache for 10 minutes, keyed by order, so
 * the small card, the big picture and every tablet share ONE download from
 * Salesforce instead of each asking at once (asking twice at the same moment is
 * what made the small cards fail). Only a signed-in catcher can read it, and an
 * order only gets into the cache after passing the In Production check.
 */
import { json, errorResponse, SF_ID } from "./_sf.js";
import { requireUser } from "./_session.js";
import { loadOneOrder } from "./_orders.js";
import { mockupUrlsFor, fetchMockup } from "./_mockup.js";

const CACHE_SECONDS = 600;
const inFlight = new Map(); // orderId -> Promise<{type, bytes}|null>, so one isolate never fetches the same picture twice at once

// Every answer gets its OWN copy of the bytes: on Cloudflare a body handed to one
// Response can't be used again, and the same picture may be going to several
// requests that were waiting on one download.
function pictureResponse(pic) {
  return new Response(pic.bytes.slice(0), {
    headers: { "Content-Type": pic.type, "Cache-Control": "private, max-age=300", "X-Content-Type-Options": "nosniff" },
  });
}

export async function onRequestGet({ request, env, waitUntil }) {
  const auth = await requireUser(request, env);
  if (auth.response) return auth.response;
  try {
    const orderId = new URL(request.url).searchParams.get("orderId") || "";
    if (!SF_ID.test(orderId)) return json({ error: "bad_order_id", message: "That order link is not valid." }, 400);

    const cache = typeof caches !== "undefined" ? caches.default : null;
    const key = new Request(`https://mockup-cache.internal/${orderId}`);
    if (cache) {
      const hit = await cache.match(key);
      if (hit) {
        return new Response(hit.body, { headers: {
          "Content-Type": hit.headers.get("Content-Type") || "application/octet-stream",
          "Cache-Control": "private, max-age=300", "X-Content-Type-Options": "nosniff" } });
      }
    }

    let job = inFlight.get(orderId);
    if (!job) {
      job = (async () => {
        const order = await loadOneOrder(env, orderId);
        const raw = (await mockupUrlsFor(env, [order])).get(order.id);
        if (!raw) return { none: true };
        return fetchMockup(env, raw);
      })().finally(() => inFlight.delete(orderId));
      inFlight.set(orderId, job);
    }
    const pic = await job;
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
