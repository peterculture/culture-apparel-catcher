/**
 * GET /api/orders
 * The In Production screen-print orders, with garments by size, the boxes
 * already logged, and whether a mockup image exists. Read-only.
 */
import { json, errorResponse } from "./_sf.js";
import { requireUser } from "./_session.js";
import { loadOrders } from "./_orders.js";
import { mockupUrlsFor } from "./_mockup.js";
import { existingNotes } from "./misprints.js";

export async function onRequestGet({ request, env }) {
  const auth = await requireUser(request, env);
  if (auth.response) return auth.response;
  try {
    const orders = await loadOrders(env);
    const mockups = await mockupUrlsFor(env, orders);
    const out = orders.map((o) => {
      const { misprintDetails, artworkUrl, ...rest } = o;
      return Object.assign(rest, { hasMockup: mockups.has(o.id), misprintNotes: existingNotes(misprintDetails) });
    });
    return json({ orders: out, at: new Date().toISOString() });
  } catch (err) {
    return errorResponse(err);
  }
}
