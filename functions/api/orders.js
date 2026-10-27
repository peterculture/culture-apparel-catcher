/**
 * GET /api/orders
 * The In Production screen-print orders, with garments by size, the boxes
 * already logged, and whether a mockup image exists. Read-only.
 */
import { stripItems } from "./_orders.js";
import { json, errorResponse } from "./_sf.js";
import { requireUser } from "./_session.js";
import { loadOrders } from "./_orders.js";
import { mockupUrlsFor, mockupFilesFor } from "./_mockup.js";
import { existingNotes } from "./misprints.js";

export async function onRequestGet({ request, env }) {
  const auth = await requireUser(request, env);
  if (auth.response) return auth.response;
  try {
    const orders = await loadOrders(env);
    const [links, files] = await Promise.all([mockupUrlsFor(env, orders), mockupFilesFor(env, orders)]);
    const out = orders.map((o) => {
      const { misprintDetails, artworkUrl, ...rest } = o;
      // Pictures attached to the order (its Files list) come first; the Artwork URL file is the fallback.
      const n = (files.get(o.id) || []).length || (links.has(o.id) ? 1 : 0);
      stripItems(rest);
      return Object.assign(rest, { hasMockup: n > 0, mockupCount: n, misprintNotes: existingNotes(misprintDetails) });
    });
    return json({ orders: out, at: new Date().toISOString() });
  } catch (err) {
    return errorResponse(err);
  }
}
