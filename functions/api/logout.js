/** POST /api/logout — clears the sign-in cookie. */
import { json } from "./_sf.js";
import { clearCookie } from "./_session.js";

export async function onRequestPost() {
  return json({ ok: true }, 200, { "Set-Cookie": clearCookie() });
}
