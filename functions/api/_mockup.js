/**
 * Mockup images.
 *
 * Source, checked in Production 2026-10-14:
 *   1. Order.Artwork_URL__c -- a public Salesforce file link
 *      (https://cultureapparel.file.force.com/sfc/dist/version/download/?oid=..&ids=068..&d=..).
 *      Every In Production screen-print order had one. Fetched as-is: the link is
 *      public, so the app's Salesforce user needs no access to the file itself.
 *   2. Fallback: the newest Design__c.Mockup_URL__c on the order's Opportunity
 *      (empty on every Production design checked, kept in case that changes).
 *
 * The browser never receives the stored link. It asks /api/mockup?orderId=...
 * and this server fetches the picture, so:
 *  - Salesforce-hosted files are fetched with the app's own sign-in;
 *  - the app can only ever show the mockup of an order it is allowed to show
 *    (there is no "fetch any URL" door for someone to abuse).
 */
import { runQuery, sfFetch, apiVersion, soqlQuote } from "./_sf.js";

const SAFE_ID = /^[a-zA-Z0-9]{15,18}$/;
const SF_HOST_RE = /(^|\.)(salesforce\.com|force\.com|documentforce\.com|salesforce-sites\.com)$/i;
const CV_ID = /(068[a-zA-Z0-9]{12,15})/;
const CD_ID = /(069[a-zA-Z0-9]{12,15})/;
const PUBLIC_LINK_RE = /\/sfc\/p\/[a-zA-Z0-9]+\/a\/([a-zA-Z0-9]{12,15})(?:[/?#]|$)/;
const MAX_BYTES = 15 * 1024 * 1024;
const MAX_REDIRECTS = 3;

/** orderId -> stored mockup link, for the orders given. Never throws: no picture is not an error. */
export async function mockupUrlsFor(env, orders) {
  const map = new Map();
  for (const o of orders) if (o.artworkUrl && /^https:\/\//i.test(o.artworkUrl)) map.set(o.id, o.artworkUrl);
  const opps = [...new Set(orders.filter((o) => !map.has(o.id)).map((o) => o.opportunityId).filter((id) => id && SAFE_ID.test(id)))];
  if (!opps.length) return map;
  try {
    const recs = await runQuery(env,
      `SELECT Opportunity__c, Mockup_URL__c FROM Design__c WHERE Opportunity__c IN (${opps.map(soqlQuote).join(",")})` +
      ` AND Mockup_URL__c != null ORDER BY LastModifiedDate DESC`);
    const byOpp = new Map();
    for (const r of recs) if (!byOpp.has(r.Opportunity__c)) byOpp.set(r.Opportunity__c, r.Mockup_URL__c);
    for (const o of orders) if (!map.has(o.id) && byOpp.has(o.opportunityId)) map.set(o.id, byOpp.get(o.opportunityId));
  } catch (err) {
    console.error("mockup lookup failed", err && err.message);
  }
  return map;
}

function blockedHost(hostname) {
  const h = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!h || h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (h.includes(":")) return true;
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = +v4[1], b = +v4[2];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  return false;
}

/** Which Salesforce file (ContentVersion id) a stored link points at, or null. */
async function contentVersionFor(env, raw) {
  let u;
  try { u = new URL(raw); } catch (_) {
    const bare = String(raw).match(/^(068[a-zA-Z0-9]{12,15})$/);
    return bare ? bare[1] : null;
  }
  if (!SF_HOST_RE.test(u.hostname)) return null;
  const cv = raw.match(CV_ID);
  if (cv && SAFE_ID.test(cv[1])) return cv[1];
  try {
    const pub = u.pathname.match(PUBLIC_LINK_RE);
    if (pub) {
      const distId = /^05D/.test(pub[1]) ? pub[1] : "05D" + pub[1];
      if (!SAFE_ID.test(distId)) return null;
      const r = await runQuery(env, `SELECT ContentVersionId FROM ContentDistribution WHERE Id = ${soqlQuote(distId)} LIMIT 1`);
      return (r[0] && r[0].ContentVersionId) || null;
    }
    const cd = raw.match(CD_ID);
    if (cd && SAFE_ID.test(cd[1])) {
      const r = await runQuery(env, `SELECT Id FROM ContentVersion WHERE ContentDocumentId = ${soqlQuote(cd[1])} AND IsLatest = true LIMIT 1`);
      return (r[0] && r[0].Id) || null;
    }
  } catch (err) {
    console.error("mockup file lookup failed", err && err.message);
  }
  return null;
}

function imageResponse(resp) {
  const type = resp.headers.get("content-type") || "application/octet-stream";
  // Pictures and PDFs only -- never hand the browser a web page.
  if (!/^image\//i.test(type) && !/^application\/pdf/i.test(type) && !/octet-stream/i.test(type)) return null;
  return new Response(resp.body, {
    headers: { "Content-Type": type, "Cache-Control": "private, max-age=300", "X-Content-Type-Options": "nosniff" },
  });
}

/** Fetch the picture behind a stored link. Returns a Response or null. */
export async function fetchMockup(env, raw) {
  let isPublicDist = false;
  try { const u = new URL(raw); isPublicDist = SF_HOST_RE.test(u.hostname) && /\/sfc\/(dist|p)\//.test(u.pathname); } catch (_) {}
  const cvId = isPublicDist ? null : await contentVersionFor(env, raw);
  if (cvId) {
    const resp = await sfFetch(env, `/services/data/${apiVersion(env)}/sobjects/ContentVersion/${encodeURIComponent(cvId)}/VersionData`);
    return resp.ok ? imageResponse(resp) : null;
  }
  let current;
  try { current = new URL(raw); } catch (_) { return null; }
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if ((current.protocol !== "https:" && current.protocol !== "http:") || blockedHost(current.hostname)) return null;
    const resp = await fetch(current.toString(), { redirect: "manual", signal: AbortSignal.timeout(10000) });
    if (resp.status >= 300 && resp.status < 400 && resp.headers.get("location")) {
      current = new URL(resp.headers.get("location"), current);
      continue;
    }
    if (!resp.ok) return null;
    if (Number(resp.headers.get("content-length") || 0) > MAX_BYTES) return null;
    return imageResponse(resp);
  }
  return null;
}
