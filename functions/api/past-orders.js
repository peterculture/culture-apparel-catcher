/**
 * GET /api/past-orders
 *
 * PAST ORDERS: screen-print orders that have boxes logged in the last 30 days,
 * newest box first, read straight from Salesforce (never from what the tablet
 * remembers). Each box carries its Salesforce creation time, its edit deadline
 * (creation + 7 days) and whether it can still be changed -- worked out on this
 * server's clock. Read-only.
 */
import { stripItems } from "./_orders.js";
import { json, errorResponse, runQuery, soqlQuote } from "./_sf.js";
import { requireUser } from "./_session.js";
import { loadReviewOrders, printerNames } from "./_orders.js";

export const PAST_DAYS = 30;
const MAX_ORDERS = 60;

export async function onRequestGet({ request, env }) {
  const auth = await requireUser(request, env);
  if (auth.response) return auth.response;
  try {
    const recent = await runQuery(env,
      `SELECT Order__c, CreatedDate FROM Order_Packaging__c WHERE CreatedDate = LAST_N_DAYS:${PAST_DAYS}` +
      ` AND Order__r.Printer__r.Name IN (${printerNames(env).map(soqlQuote).join(",")})` +
      ` ORDER BY CreatedDate DESC LIMIT 2000`);
    const latest = new Map();               // orderId -> newest box time
    for (const r of recent) if (r.Order__c && !latest.has(r.Order__c)) latest.set(r.Order__c, r.CreatedDate);
    const ids = [...latest.keys()].slice(0, MAX_ORDERS);
    const orders = await loadReviewOrders(env, ids);
    orders.sort((a, b) => String(latest.get(b.id)).localeCompare(String(latest.get(a.id))));
    const out = orders.map((o) => {
      const { misprintDetails, artworkUrl, ...rest } = o;
      stripItems(rest);
      return Object.assign(rest, { lastBoxAt: latest.get(o.id) || null, hasMockup: false });
    });
    return json({ orders: out, days: PAST_DAYS, at: new Date().toISOString() });
  } catch (err) {
    return errorResponse(err);
  }
}
