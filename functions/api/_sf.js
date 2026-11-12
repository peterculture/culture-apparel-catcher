/**
 * Salesforce connection for The Catch app.
 *
 * WHICH ORG (11-12, Anthony: "a Salesforce environment switcher, just like the Forge, so that I
 * can test how the Catcher works with the Forge system"; "a preview version of Catch ... in
 * staging and leave the production version on production Salesforce").
 *
 *   THE LIVE SITE (the floor's tablets) talks to Production and nothing else. SF_ENV_SWITCH is not
 *   set there, so nothing -- not a KV value, not a request -- can move it to another org.
 *
 *   THE PREVIEW SITE (Cloudflare Pages "Preview" environment, branch `preview`) sets
 *   SF_ENV_SWITCH=on. It can be switched between dev2 and staging, like The Forge (one KV value,
 *   sf_env:active, for every tablet on the PREVIEW site). Production is never selectable there:
 *   a test tablet can't write to the real floor's orders by accident.
 *
 * Secrets (Cloudflare Pages > Settings > Variables and Secrets, encrypted):
 *   Production (the live site, unchanged):
 *     SF_LOGIN_URL      e.g. https://cultureapparel.my.salesforce.com
 *     SF_CLIENT_ID      the connected app's Consumer Key
 *     SF_CLIENT_SECRET  the connected app's Consumer Secret
 *   Sandboxes (the preview site; the same three values The Forge uses):
 *     SF_ENV_DEV2_LOGIN_URL / SF_ENV_DEV2_CLIENT_ID / SF_ENV_DEV2_CLIENT_SECRET
 *     SF_ENV_STAGING_LOGIN_URL / SF_ENV_STAGING_CLIENT_ID / SF_ENV_STAGING_CLIENT_SECRET
 *   Switch (preview site only):
 *     SF_ENV_SWITCH       "on"
 *     SF_DEFAULT_ENV      the org it starts on, e.g. "staging"
 *     SF_ENV_SWITCH_PIN   the PIN that confirms a switch
 * Optional plain variable:
 *   SF_API_VERSION    default v61.0
 *
 * Every endpoint resolves the org ONCE, at the start of the request (orgFor), and passes an env
 * carrying SF_ORG down, so one request can never read one org and write another. Everything
 * cached in memory (sign-in, describe, "field missing" fallbacks) is kept per org.
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

const cachedTokens = new Map();   // org -> { token, instanceUrl, exp } -- a FINISHED sign-in, safe to share

/* ---------------- which org ---------------- */
export const SF_ENVIRONMENTS = [
  { key: "production", label: "Production" },
  { key: "staging", label: "Staging" },
  { key: "dev2", label: "Dev2" },
];
const ORG_KEYS = new Set(SF_ENVIRONMENTS.map((e) => e.key));
export const ACTIVE_ORG_KV_KEY = "sf_env:active";

/** The switch is on only where SF_ENV_SWITCH=on (the preview site). */
export function switchOn(env) {
  return String((env && env.SF_ENV_SWITCH) || "").trim().toLowerCase() === "on";
}
/** The org a site starts on: Production on the live site; SF_DEFAULT_ENV on the preview site. */
export function homeOrg(env) {
  if (!switchOn(env)) return "production";
  const k = String(env.SF_DEFAULT_ENV || "").trim().toLowerCase();
  return ORG_KEYS.has(k) && k !== "production" ? k : "staging";
}
export function orgLabel(key) {
  const e = SF_ENVIRONMENTS.find((x) => x.key === key);
  return e ? e.label : String(key || "");
}
/** The org this request was resolved to (orgFor), else the site's home org. */
export function orgOf(env) {
  const k = env && env.SF_ORG;
  return k && ORG_KEYS.has(k) ? k : homeOrg(env || {});
}
/** Login details for one org. Production keeps the original three secret names. */
export function credsFor(env, org) {
  const up = String(org).toUpperCase();
  const c = { loginUrl: env[`SF_ENV_${up}_LOGIN_URL`], clientId: env[`SF_ENV_${up}_CLIENT_ID`], clientSecret: env[`SF_ENV_${up}_CLIENT_SECRET`] };
  if (org === "production" && !(c.loginUrl && c.clientId && c.clientSecret)) {
    return { loginUrl: env.SF_LOGIN_URL, clientId: env.SF_CLIENT_ID, clientSecret: env.SF_CLIENT_SECRET };
  }
  return c;
}
export function isOrgConfigured(env, org) {
  const c = credsFor(env, org);
  return !!(c.loginUrl && c.clientId && c.clientSecret);
}
/** May this site be switched to this org? Only on the preview site, never Production, only with logins set. */
export function isSelectable(env, org) {
  return switchOn(env) && ORG_KEYS.has(org) && org !== "production" && isOrgConfigured(env, org);
}

/** Which org this site uses right now. The live site: always Production, whatever KV says. */
export async function activeOrg(env) {
  const home = homeOrg(env);
  if (!switchOn(env) || !env.CATCHER_KV) return home;
  try {
    const stored = await env.CATCHER_KV.get(ACTIVE_ORG_KV_KEY);
    return stored && isSelectable(env, stored) ? stored : home;
  } catch (err) {
    console.error("activeOrg: KV read failed, using", home, err && err.message);
    return home;
  }
}
export async function setActiveOrg(env, org) {
  if (!isSelectable(env, org)) throw new SfError("org_not_selectable", 409, `${orgLabel(org)} can't be picked on this site.`);
  await env.CATCHER_KV.put(ACTIVE_ORG_KV_KEY, org);
}

/**
 * The start of every endpoint: which org this request uses, fixed for the whole request.
 * Returns { env } (the site's env plus SF_ORG) or { response } when a SAVE was made on a screen
 * that was still showing another org (header X-Catch-Org): nothing is sent to Salesforce then.
 */
export async function orgFor(request, baseEnv) {
  const org = await activeOrg(baseEnv);
  const env = Object.create(baseEnv);
  env.SF_ORG = org;
  const method = String((request && request.method) || "GET").toUpperCase();
  const said = request && request.headers && request.headers.get("X-Catch-Org");
  if (method !== "GET" && said && said !== org) {
    return { env, response: json({ error: "org_changed", org, orgLabel: orgLabel(org),
      message: `This site switched to ${orgLabel(org)} while your screen still showed ${orgLabel(said)}, so nothing was saved. The lists are reloading.` }, 409) };
  }
  return { env };
}

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

async function login(env, org = orgOf(env)) {
  const { loginUrl: SF_LOGIN_URL, clientId: SF_CLIENT_ID, clientSecret: SF_CLIENT_SECRET } = credsFor(env, org);
  if (!SF_LOGIN_URL || !SF_CLIENT_ID || !SF_CLIENT_SECRET) {
    throw new SfError("org_not_configured", 409,
      (org === "production" ? "The app is not connected to Salesforce yet." : `The app has no ${orgLabel(org)} login set up yet.`) + " Tell a manager.", "secrets");
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
  const org = orgOf(env);
  const hit = cachedTokens.get(org);
  if (!force && hit && hit.exp - Date.now() > 60000) return hit;
  try {
    const t = await login(env, org);
    cachedTokens.set(org, t);
    return t;
  } catch (err) {
    if (force) cachedTokens.delete(org);
    throw err;
  }
}

/** Before a switch: does this org's login actually work? Nothing is cached or changed. */
export async function testOrgLogin(env, org) {
  try { await login(env, org); return { ok: true }; }
  catch (err) { return { ok: false, code: (err && err.code) || "sf_auth_failed", message: (err && err.message) || "" }; }
}

/** Test hook: forget the cached tokens. */
export function _resetTokenCache() { cachedTokens.clear(); }

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
  const key = orgOf(env) + ":" + object;
  const hit = describeCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.data;
  const resp = await sfFetch(env, `/services/data/${apiVersion(env)}/sobjects/${object}/describe`);
  const data = await resp.json().catch(() => null);
  if (!resp.ok || !data || !Array.isArray(data.fields)) {
    throw new SfError("describe_failed", 502, "Could not read Salesforce settings. Try again in a moment.");
  }
  describeCache.set(key, { at: Date.now(), data });
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

/** A KV key for this org's own data. Production keeps the original key, so the floor's board memory is untouched. */
export function orgKvKey(env, base) {
  const org = orgOf(env);
  return org === "production" ? base : `${base}:${org}`;
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
