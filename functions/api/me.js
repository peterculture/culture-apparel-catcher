/** GET /api/me — who is signed in on this tablet (401 if nobody). */
import { json, orgFor, orgOf, orgLabel, switchOn } from "./_sf.js";
import { requireUser } from "./_session.js";
import { REASONS } from "./misprints.js";

export async function onRequestGet({ request, env: siteEnv }) {
  // Which Salesforce org this request uses, fixed for the whole request (11-12, see _sf.js).
  const org = await orgFor(request, siteEnv);
  if (org.response) return org.response;
  const env = org.env;
  const auth = await requireUser(request, env);
  if (auth.response) return auth.response;
  // expiresIn: seconds left in this sign-in, by the server's clock (the tablet counts down from it).
  // org: which Salesforce org this site is on now; switchable only on the preview site (11-12).
  return json({ name: auth.user.name, reasons: REASONS, expiresIn: auth.user.expiresIn,
    org: { key: orgOf(env), label: orgLabel(orgOf(env)), switchable: switchOn(env) } });
}
