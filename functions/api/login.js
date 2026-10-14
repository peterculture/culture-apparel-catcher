/**
 * POST /api/login  { pin }
 * Checks the PIN against CATCHER_PINS and sets the sign-in cookie.
 */
import { json } from "./_sf.js";
import { matchPin, issueCookie, pinLocked, notePinFail, clearPinFails } from "./_session.js";

export async function onRequestPost({ request, env }) {
  try {
    if (await pinLocked(request, env)) {
      return json({ error: "locked", message: "Too many wrong PINs. Wait 5 minutes, then try again." }, 429);
    }
    const body = await request.json().catch(() => null);
    const pin = String((body && body.pin) || "");
    if (!/^\d{4}$/.test(pin)) return json({ error: "bad_pin", message: "Enter your 4-digit PIN." }, 400);

    let name;
    try {
      name = matchPin(env, pin);
    } catch (err) {
      console.error("PIN list problem:", err.code);
      return json({ error: "setup", message: "Sign-in isn't set up correctly. Tell a manager." }, 500);
    }
    if (!name) {
      await notePinFail(request, env);
      return json({ error: "wrong_pin", message: "That PIN didn't match. Try again." }, 401);
    }
    await clearPinFails(request, env);
    let cookie;
    try {
      cookie = await issueCookie(env, name);
    } catch (err) {
      return json({ error: "setup", message: "Sign-in isn't set up correctly. Tell a manager." }, 500);
    }
    return json({ ok: true, name }, 200, { "Set-Cookie": cookie });
  } catch (err) {
    console.error(err);
    return json({ error: "internal_error", message: "Something went wrong. Try again." }, 500);
  }
}
