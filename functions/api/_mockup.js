/**
 * Mockup images.
 *
 * Source, checked in Production 2026-10-14:
 *   1. Order.Artwork_URL__c -- a public Salesforce file link
 *      (https://cultureapparel.file.force.com/sfc/dist/version/download/?oid=..&ids=068..&d=..).
 *      Every In Production screen-print order had one. Fetched as-is: the link is
 *      public, so the app's Salesforce user needs no access to the file itself.
 *   (Design__c.Mockup_URL__c was empty on every Production design checked, and
 *   reading Designs would need Opportunity access, so it is not used.)
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
const MAX_BYTES = 40 * 1024 * 1024; // Illustrator files run larger than pictures
const MAX_REDIRECTS = 3;

/** orderId -> stored mockup link, for the orders given. No picture is not an error. */
export async function mockupUrlsFor(env, orders) {
  const map = new Map();
  for (const o of orders) if (o.artworkUrl && /^https:\/\//i.test(o.artworkUrl)) map.set(o.id, o.artworkUrl);
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

/**
 * What a file really is, from its first bytes -- not from what the server claims.
 * Adobe Illustrator (.ai) files saved "PDF compatible" (Illustrator's default)
 * ARE PDFs and start with "%PDF", even though Salesforce labels them
 * application/postscript. Anything not listed here is never passed on.
 */
export function sniffType(bytes) {
  const b = new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 1024));
  const head = (n, from = 0) => String.fromCharCode.apply(null, Array.from(b.subarray(from, from + n)));
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x89 && head(3, 1) === "PNG") return "image/png";
  if (head(4) === "GIF8") return "image/gif";
  if (head(4) === "RIFF" && head(4, 8) === "WEBP") return "image/webp";
  // "%PDF" must be within the first 1 KB (the PDF rule); usually it is at byte 0.
  if (head(b.length).indexOf("%PDF-") >= 0) return "application/pdf";
  return null;
}

/** Pictures and PDFs only -- never hand the browser a web page. Returns { type, bytes } or null. */
async function readPicture(resp, where) {
  const claimed = (resp.headers.get("content-type") || "application/octet-stream").split(";")[0].trim();
  if (/^text\//i.test(claimed) || /html|xml|json|javascript/i.test(claimed)) {
    console.error("mockup: not a picture", where, resp.status, claimed);
    return null;
  }
  const bytes = await resp.arrayBuffer();
  if (bytes.byteLength > MAX_BYTES) { console.error("mockup: too large", where, bytes.byteLength); return null; }
  const type = sniffType(bytes);
  if (!type) {
    const start = String.fromCharCode.apply(null, Array.from(new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 12))));
    console.error(/^%!PS/.test(start) || (bytes.byteLength > 4 && new Uint8Array(bytes)[0] === 0xc5)
      ? "mockup: Illustrator/EPS file saved without a PDF copy -- re-save it with 'Create PDF Compatible File' ticked"
      : "mockup: not a picture", where, claimed, bytes.byteLength);
    return null;
  }
  return { type, bytes };
}

/** Fetch the picture behind a stored link. Returns { type, bytes } or null. */
export async function fetchMockup(env, raw) {
  let isPublicDist = false;
  try { const u = new URL(raw); isPublicDist = SF_HOST_RE.test(u.hostname) && /\/sfc\/(dist|p)\//.test(u.pathname); } catch (_) {}
  const cvId = isPublicDist ? null : await contentVersionFor(env, raw);
  if (cvId) {
    const resp = await sfFetch(env, `/services/data/${apiVersion(env)}/sobjects/ContentVersion/${encodeURIComponent(cvId)}/VersionData`);
    if (!resp.ok) { console.error("mockup: ContentVersion fetch failed", resp.status); return null; }
    return readPicture(resp, "contentversion");
  }
  let current;
  try { current = new URL(raw); } catch (_) { return null; }
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if ((current.protocol !== "https:" && current.protocol !== "http:") || blockedHost(current.hostname)) return null;
    const resp = await fetch(current.toString(), {
      redirect: "manual",
      headers: { Accept: "image/*,application/pdf;q=0.9,*/*;q=0.5" },
      signal: AbortSignal.timeout(15000),
    });
    if (resp.status >= 300 && resp.status < 400 && resp.headers.get("location")) {
      current = new URL(resp.headers.get("location"), current);
      continue;
    }
    if (!resp.ok) { console.error("mockup: link answered", resp.status, current.hostname, current.pathname.slice(0, 40)); return null; }
    if (Number(resp.headers.get("content-length") || 0) > MAX_BYTES) return null;
    return readPicture(resp, current.hostname + current.pathname.slice(0, 40));
  }
  console.error("mockup: too many redirects");
  return null;
}
