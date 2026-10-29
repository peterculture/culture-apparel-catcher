/**
 * Salesforce connection for The Catch app.
 *
 * ONE org only (Production). There is deliberately no environment switcher:
 * this app talks to exactly the org its three secrets point at.
 *
 * Secrets (Cloudflare Pages > Settings > Variables and Secrets, encrypted):
 *   SF_LOGIN_URL      e.g. https://cultureapparel.my.salesforce.com
 *   SF_CLIENT_ID      the connected app's Consumer Key
 *   SF_CLIENT_SECRET  the connected app's Consumer Secret
 * Optional plain variable:
 *   SF_API_VERSION    default v61.0
 *
 * Login is OAuth "client credentials": the connected app logs in as its own
 * dedicated integration user. No password is ever stored here.
 *
 * Patterns kept from the production dashboard, because each one was learned
 * the hard way there:
 *  - a failed query is an ERROR, never "zero rows" (a 200 without `records`
 *    is treated as a failure);
 *  - an expired token gets exactly one retry with a fresh one;
 *  - reads time out; a write that times out is reported as UNCONFIRMED,
 *    never as saved and never as failed, because Salesforce may still have
 *    done it.
 *
 * Refresh and loading rules copied from The Forge (handoff 2026-10-29):
 *  - NEVER share an in-flight promise between requests. Only FINISHED data is
 *    shared (a finished token, a finished describe); each request makes its own
 *    call. The Forge once shared a sign-in promise: a cancelled tablet request
 *    left it hanging and every screen stalled within minutes.
 *  - Salesforce reads give up after 30 s; a sign-in try after 8 s, with one
 *    quick retry.
 *  - Errors name the kind of failure, so the tablet can say "come back later"
 *    or "this was never set up": 409 org_not_configured (the missing object or
 *    field), sf_auth_failed (Salesforce refused the sign-in), query_failed with
 *    Salesforce's own sentence.
 */

const TOKEN_TTL_MS = 90 * 60 * 1000;
const READ_TIMEOUT_MS = 30000;
const WRITE_TIMEOUT_MS = 25000;
const LOGIN_TIMEOUT_MS = 8000;
const LOGIN_RETRY_PAUSE_MS = 400;

let cachedToken = null;   // { token, instanceUrl, exp } -- a FINISHED sign-in, safe to share

export class SfError extends Error {
  /** code: short machine word; status: HTTP status to send the browser;
   *  message: human-readable, safe to show a catcher. */
  constructor(code, status, message, detail) {
    super(message || code);
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

export function apiVersion(env) {
  const v = String(env.SF_API_VERSION || "v61.0");
  return /^v\d+\.\d$/.test(v) ? v : "v61.0";
}

async function login(env) {
  const { SF_LOGIN_URL, SF_CLIENT_ID, SF_CLIENT_SECRET } = env;
  if (!SF_LOGIN_URL || !SF_CLIENT_ID || !SF_CLIENT_SECRET) {
    throw new SfError("org_not_configured", 409, "The app is not connected to Salesforce yet. Tell a manager.", "secrets");
  }
  const tryOnce = () => fetch(`${String(SF_LOGIN_URL).replace(/\/+$/, "")}/services/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: SF_CLIENT_ID,
      client_secret: SF_CLIENT_SECRET,
    }),
    signal: AbortSignal.timeout(LOGIN_TIMEOUT_MS),
  });
  let resp;
  try {
    resp = await tryOnce();
  } catch (err) {
    // No answer in 8 s: one quick retry. (A refusal is an answer, and is never retried.)
    await new Promise((r) => setTimeout(r, LOGIN_RETRY_PAUSE_MS));
    try { resp = await tryOnce(); } catch (err2) {
      throw new SfError("sf_unreachable", 504, "Salesforce did not answer. Check the internet connection and try again.");
    }
  }
  if (!resp.ok) {
    console.error("Salesforce login failed", resp.status);
    throw new SfError("sf_auth_failed", 502, "The app could not sign in to Salesforce. Tell a manager.");
  }
  const data = await resp.json().catch(() => null);
  if (!data || !data.access_token || !data.instance_url) {
    throw new SfError("sf_auth_failed", 502, "The app could not sign in to Salesforce. Tell a manager.");
  }
  return { token: data.access_token, instanceUrl: data.instance_url, exp: Date.now() + TOKEN_TTL_MS };
}

/** A finished token is shared; a sign-in in progress never is -- each request signs in itself. */
export async function getToken(env, { force = false } = {}) {
  if (!force && cachedToken && cachedToken.exp - Date.now() > 60000) return cachedToken;
  try {
    const t = await login(env);
    cachedToken = t;
    return t;
  } catch (err) {
    if (force) cachedToken = null;
    throw err;
  }
}

/** Test hook: forget the cached token. */
export function _resetTokenCache() { cachedToken = null; }

/** Turn a Salesforce error body into one readable sentence. */
export function sfMessage(data) {
  const first = Array.isArray(data) ? data[0] : data;
  const msg = first && (first.message || first.error_description);
  return msg ? String(msg).replace(/\s+/g, " ").trim().slice(0, 300) : "";
}
export function sfErrorCode(data) {
  const first = Array.isArray(data) ? data[0] : data;
  return (first && (first.errorCode || first.error)) || "";
}

/**
 * Raw call to the Salesforce REST API. `path` starts with /services/...
 * Returns the Response. Throws SfError only for timeouts / no answer.
 */
export async function sfFetch(env, path, init = {}) {
  const method = (init.method || "GET").toUpperCase();
  const isRead = method === "GET";
  const attempt = async (force) => {
    const t = await getToken(env, { force });
    const headers = Object.assign({}, init.headers || {}, { Authorization: `Bearer ${t.token}` });
    try {
      return await fetch(t.instanceUrl + path, Object.assign({}, init, {
        headers,
        signal: AbortSignal.timeout(isRead ? READ_TIMEOUT_MS : WRITE_TIMEOUT_MS),
      }));
    } catch (err) {
      if (isRead) throw new SfError("sf_timeout", 504, "Salesforce is slow right now. Try again in a moment.");
      throw new SfError("unconfirmed", 504,
        "Salesforce took too long to answer, so we can't tell if this saved. Check the order before trying again.");
    }
  };
  let resp = await attempt(false);
  if (resp.status === 401) resp = await attempt(true);
  return resp;
}

/** SOQL query, following every page. Returns the records array or throws. */
export async function runQuery(env, soql) {
  const v = apiVersion(env);
  let path = `/services/data/${v}/query?q=${encodeURIComponent(soql)}`;
  const records = [];
  for (let page = 0; page < 50 && path; page++) {
    const resp = await sfFetch(env, path);
    const data = await resp.json().catch(() => null);
    if (!resp.ok) {
      const code = sfErrorCode(data), msg = sfMessage(data);
      console.error("SOQL failed", resp.status, code, msg);
      if (code === "INVALID_FIELD" || code === "INVALID_TYPE") {
        // Salesforce is missing (or hiding from the app's login) something this screen reads.
        throw new SfError("org_not_configured", 409,
          "Salesforce is missing something this screen reads" + (msg ? `: "${msg}"` : ".") + " Tell a manager.", code);
      }
      throw new SfError("query_failed", 502,
        "Could not read from Salesforce" + (msg ? `: "${msg}"` : ".") + " Try again in a moment.", code);
    }
    if (!data || !Array.isArray(data.records)) {
      throw new SfError("query_failed", 502, "Salesforce sent back something unexpected. Try again in a moment.");
    }
    records.push(...data.records);
    path = data.done ? null : data.nextRecordsUrl;
  }
  return records;
}

/** Describe an object's fields (cached 10 minutes per isolate). */
const describeCache = new Map();
export async function describe(env, object) {
  const hit = describeCache.get(object);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.data;
  const resp = await sfFetch(env, `/services/data/${apiVersion(env)}/sobjects/${object}/describe`);
  const data = await resp.json().catch(() => null);
  if (!resp.ok || !data || !Array.isArray(data.fields)) {
    throw new SfError("describe_failed", 502, "Could not read Salesforce settings. Try again in a moment.");
  }
  describeCache.set(object, { at: Date.now(), data });
  return data;
}
export function _resetDescribeCache() { describeCache.clear(); }

/** Active values of a picklist, in Salesforce's order. */
export async function picklistValues(env, object, field) {
  const d = await describe(env, object);
  const f = d.fields.find((x) => x.name === field);
  if (!f) throw new SfError("org_not_configured", 409, `Salesforce field ${object}.${field} is missing or hidden from the app user. Tell a manager.`, "field_missing");
  return (f.picklistValues || []).filter((p) => p.active).map((p) => ({ value: p.value, label: p.label || p.value, isDefault: !!p.defaultValue }));
}

export function soqlEscape(value) {
  return String(value == null ? "" : value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}
export function soqlQuote(value) { return `'${soqlEscape(value)}'`; }

export const SF_ID = /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/;

/** Salesforce HYPERLINK() formulas arrive as <a href=...>text</a>; keep the text. */
export function plainText(value) {
  if (value == null) return "";
  let s = String(value);
  if (s.indexOf("<") >= 0) s = s.replace(/<[^>]*>/g, "");
  if (s.indexOf("&") >= 0) {
    s = s.replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&(?:apos|#0*39);/g, "'").replace(/&amp;/g, "&");
  }
  return s.replace(/\s+/g, " ").trim();
}

export function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: Object.assign({ "Content-Type": "application/json", "Cache-Control": "no-store" }, extraHeaders),
  });
}

/** Every endpoint's catch-all: SfError -> its own status and message; anything else -> 500. */
export function errorResponse(err) {
  if (err instanceof SfError) {
    return json({ error: err.code, message: err.message }, err.status);
  }
  console.error("Unexpected error", err && err.stack ? err.stack : err);
  return json({ error: "internal_error", message: "Something went wrong in the app. Try again, and tell a manager if it keeps happening." }, 500);
}
