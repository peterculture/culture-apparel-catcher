/**
 * POST /api/logout -- ends this sign-in: cancels it on the server (so the cookie
 * can't be used again, even if copied) and clears it from the tablet.
 */
import { json } from "./_sf.js";
import { clearCookie, revokeSession } from "./_session.js";

export async function onRequestPost({ request, env }) {
  try { await revokeSession(request, env); } catch (err) { console.error("logout revoke failed", err && err.message); }
  return json({ ok: true }, 200, { "Set-Cookie": clearCookie() });
}
