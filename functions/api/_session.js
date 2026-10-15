/**
 * Catcher sign-in: a 4-digit PIN, then a signed cookie.
 *
 * Secrets:
 *   CATCHER_PINS    JSON object of name -> PIN, e.g. {"Maria R.":"4821","Dev T.":"1937"}
 *                   This app's OWN list, separate from the dashboard's.
 *   SESSION_SECRET  a long random string used to sign the cookie
 * Optional:
 *   SESSION_MINUTES how long a sign-in lasts (default 5, Anthony 2026-10-15: every
 *                   catcher signs in again every 5 minutes, so boxes are credited to
 *                   the right person). Counted on THIS server's clock, inside the
 *                   signed cookie, so a tablet can't stretch it.
 *   CATCHER_KV      a KV namespace binding. When present it is used to slow
 *                   down PIN guessing and to recognise a repeated save.
 *
 * Unlike the dashboard, there is no "report-only" mode: without a valid
 * session every /api call except login answers 401.
 */
import { json } from "./_sf.js";

const COOKIE = "ca_catch";
const enc = new TextEncoder();

function b64url(bytes) {
  let s = "";
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64url(str) {
  const s = str.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
async function hmacKey(secret) {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

/** Constant-time string compare. */
export function safeEqual(a, b) {
  a = String(a); b = String(b);
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

/** name -> pin. An unreadable list is treated as empty (nobody can sign in). */
export function roster(env) {
  try {
    const raw = JSON.parse(env.CATCHER_PINS || "{}");
    const out = new Map();
    for (const [name, pin] of Object.entries(raw || {})) {
      if (typeof name === "string" && name.trim() && /^\d{4}$/.test(String(pin))) out.set(name.trim().slice(0, 40), String(pin));
    }
    return out;
  } catch (err) {
    console.error("CATCHER_PINS is not valid JSON");
    return new Map();
  }
}

/** Returns the name for a PIN, null for no match. Two people sharing a PIN is a setup error. */
export function matchPin(env, pin) {
  let found = null, count = 0;
  for (const [name, p] of roster(env)) {
    if (safeEqual(p, pin)) { found = name; count++; }
  }
  if (count > 1) { const e = new Error("two catchers share a PIN"); e.code = "pin_shared"; throw e; }
  return found;
}

export function sessionSeconds(env) {
  return Math.round(Math.min(60, Math.max(1, Number(env.SESSION_MINUTES) || 5)) * 60);
}

/** Returns { cookie, expiresIn } -- expiresIn in seconds, by the server's clock. */
export async function issueCookie(env, name) {
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 16) {
    const e = new Error("SESSION_SECRET missing"); e.code = "no_secret"; throw e;
  }
  const secs = sessionSeconds(env);
  const now = Math.floor(Date.now() / 1000);
  // sid: this sign-in's own id, so a logout can cancel exactly this sign-in on the server.
  const sid = b64url(crypto.getRandomValues(new Uint8Array(12)));
  const payload = b64url(enc.encode(JSON.stringify({ n: name, iat: now, exp: now + secs, sid })));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(env.SESSION_SECRET), enc.encode(payload)));
  return { cookie: `${COOKIE}=${payload}.${b64url(sig)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${secs}`, expiresIn: secs };
}

export function clearCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

/** Cancel this sign-in on the server (logout), so a copied cookie stops working too. */
export async function revokeSession(request, env) {
  const s = await readSession(request, env);
  if (s && s.sid && env.CATCHER_KV) await env.CATCHER_KV.put("revoked:" + s.sid, "1", { expirationTtl: 3600 });
  return s;
}

/** The signed-in catcher, or null. Someone removed from CATCHER_PINS is signed out at once. */
export async function readSession(request, env) {
  if (!env.SESSION_SECRET) return null;
  const cookie = request.headers.get("Cookie") || "";
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!m) return null;
  const [payload, sig] = m[1].split(".");
  if (!payload || !sig) return null;
  let ok = false;
  try {
    ok = await crypto.subtle.verify("HMAC", await hmacKey(env.SESSION_SECRET), fromB64url(sig), enc.encode(payload));
  } catch (err) { return null; }
  if (!ok) return null;
  let data;
  try { data = JSON.parse(new TextDecoder().decode(fromB64url(payload))); } catch (err) { return null; }
  const now = Math.floor(Date.now() / 1000);
  if (!data || typeof data.n !== "string" || !Number.isFinite(data.exp) || data.exp < now) return null;
  if (!roster(env).has(data.n)) return null;
  if (data.sid && env.CATCHER_KV && await env.CATCHER_KV.get("revoked:" + data.sid)) return null;
  return { name: data.n, sid: data.sid || "", expiresIn: Math.max(0, data.exp - now) };
}

/** Use at the top of every protected endpoint: returns {user} or {response}. */
export async function requireUser(request, env) {
  const user = await readSession(request, env);
  if (!user) return { response: json({ error: "signed_out", message: "Please sign in again." }, 401) };
  return { user };
}

/* ---- PIN guessing brake (needs CATCHER_KV) -------------------------------- */
const MAX_FAILS = 6;          // per device address
const LOCK_SECONDS = 300;     // 5 minutes

function clientKey(request) {
  return "pinfail:" + (request.headers.get("CF-Connecting-IP") || "unknown");
}
export async function pinLocked(request, env) {
  if (!env.CATCHER_KV) return false;
  const n = Number(await env.CATCHER_KV.get(clientKey(request))) || 0;
  return n >= MAX_FAILS;
}
export async function notePinFail(request, env) {
  if (!env.CATCHER_KV) return;
  const key = clientKey(request);
  const n = (Number(await env.CATCHER_KV.get(key)) || 0) + 1;
  await env.CATCHER_KV.put(key, String(n), { expirationTtl: LOCK_SECONDS });
}
export async function clearPinFails(request, env) {
  if (env.CATCHER_KV) await env.CATCHER_KV.delete(clientKey(request));
}

/* ---- "Did we already do this save?" (needs CATCHER_KV) -------------------- */
// Each save carries a random id made by the tablet. If the same id comes in
// twice (a double tap that slipped through, or a retry after a dropped
// connection) the second one gets the first one's answer instead of saving twice.
export const REQ_ID = /^[a-zA-Z0-9-]{8,64}$/;
export async function priorResult(env, requestId) {
  if (!env.CATCHER_KV || !requestId) return null;
  const v = await env.CATCHER_KV.get("req:" + requestId);
  return v ? JSON.parse(v) : null;
}
export async function rememberResult(env, requestId, body) {
  if (!env.CATCHER_KV || !requestId) return;
  await env.CATCHER_KV.put("req:" + requestId, JSON.stringify(body), { expirationTtl: 24 * 3600 });
}
/** Claim a request id before writing; false means another copy is already running. */
export async function claimRequest(env, requestId) {
  if (!env.CATCHER_KV || !requestId) return true;
  const key = "claim:" + requestId;
  if (await env.CATCHER_KV.get(key)) return false;
  await env.CATCHER_KV.put(key, "1", { expirationTtl: 120 });
  return true;
}
export async function releaseClaim(env, requestId) {
  if (env.CATCHER_KV && requestId) await env.CATCHER_KV.delete("claim:" + requestId);
}

/**
 * Run one save under its request id.
 *  - Same id already answered  -> that answer again, nothing re-saved.
 *  - Same id still running     -> 409, nothing saved.
 *  - Save refused              -> claim released, so "Try again" works at once.
 *  - Save UNCONFIRMED (timeout)-> claim kept for 2 minutes, so an immediate
 *                                 retry can't create a duplicate.
 */
export async function withRequestId(env, requestId, okStatus, run) {
  const prior = await priorResult(env, requestId);
  if (prior) return json(prior, okStatus);
  if (!(await claimRequest(env, requestId))) {
    return json({ error: "in_progress", message: "This is already being saved. Wait a moment, then check the order." }, 409);
  }
  try {
    const resp = await run();
    if (resp.status >= 400) await releaseClaim(env, requestId);
    return resp;
  } catch (err) {
    if (!err || err.code !== "unconfirmed") await releaseClaim(env, requestId);
    throw err;
  }
}
