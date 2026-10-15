/** GET /api/me — who is signed in on this tablet (401 if nobody). */
import { json } from "./_sf.js";
import { requireUser } from "./_session.js";
import { REASONS } from "./misprints.js";

export async function onRequestGet({ request, env }) {
  const auth = await requireUser(request, env);
  if (auth.response) return auth.response;
  // expiresIn: seconds left in this sign-in, by the server's clock (the tablet counts down from it).
  return json({ name: auth.user.name, reasons: REASONS, expiresIn: auth.user.expiresIn });
}
