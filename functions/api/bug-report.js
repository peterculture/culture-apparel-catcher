/**
 * POST /api/bug-report   { text, from, screen, agent }
 *
 * HELP (11-02): the "?" button in the header opens "Found a bug? Report it here:". The catcher
 * types what went wrong; this emails it to Anthony and keeps a backup copy in KV.
 * Rebuilt from The Forge's Help page (Help Page Remake Guide, 11-02), as a pop-up, not a tab.
 *
 *   Email    To anthony@cultureapparel.com, from the org-wide address info@cultureapparel.com
 *            (else as the app's own login). Subject "Catch bug report from <name>: <first 8 words>…",
 *            body = the report, a blank line, "<name> · <Chicago date and time>". Nothing else.
 *            Sent through Salesforce (emailSimple), since Cloudflare can't send email by itself.
 *            Needs "Send Email" on Catcher_App_Access: tools/catcher-send-email.apex.
 *   Backup   KV key bugreport:<time>:<random>, 180 days, with the screen, order and device too
 *            (those are NOT emailed). Saved whether or not the email went.
 *   Answer   200 { ok: true, emailed: true|false }; 400 too short; 502 when neither worked.
 *
 * Signed-in catchers only, like every other Catch endpoint, so every report carries a name.
 */
import { sfFetch, apiVersion } from "./_sf.js";
import { requireUser } from "./_session.js";

const NO_STORE = { "Cache-Control": "no-store" };
export const BUG_REPORT_TO = "anthony@cultureapparel.com";
export const BUG_REPORT_FROM = "info@cultureapparel.com";   // Salesforce org-wide address (all profiles)
const KV_TTL = 180 * 24 * 3600;
const MAX_TEXT = 4000;

function clip(v, n) { return String(v == null ? "" : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trim().slice(0, n); }
function fail(message, status) { return Response.json({ ok: false, message }, { status, headers: NO_STORE }); }

export function chicagoTime(d) {
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", weekday: "short", month: "numeric", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }).format(d);
}

export function buildEmail(r) {
  const first = r.text.split(/\s+/).slice(0, 8).join(" ");
  const subject = `Catch bug report from ${r.name}: ${first}${r.text.length > first.length ? "…" : ""}`.slice(0, 200);
  const body = `${r.text}\n\n${r.name} · ${r.when}`;
  return { subject, body };
}

/** emailSimple over REST. Tries the org-wide sender first, then the app's own login. */
export async function sendViaSalesforce(env, to, subject, body) {
  const path = `/services/data/${apiVersion(env)}/actions/standard/emailSimple`;
  const base = { emailAddresses: to, emailSubject: subject, emailBody: body };
  const tries = [{ ...base, senderType: "OrgWideEmailAddress", senderAddress: BUG_REPORT_FROM }, base];
  let last = "";
  for (const input of tries) {
    try {
      const res = await sfFetch(env, path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ inputs: [input] }) });
      const out = await res.json().catch(() => null);
      const r = Array.isArray(out) ? out[0] : null;
      if (res.ok && r && r.isSuccess) return { ok: true };
      last = r && r.errors ? JSON.stringify(r.errors) : `HTTP ${res.status} ${JSON.stringify(out)}`.slice(0, 500);
    } catch (e) {
      last = String(e && e.message ? e.message : e);
    }
  }
  return { ok: false, error: last.slice(0, 500) };
}

export async function onRequestPost({ request, env }) {
  const auth = await requireUser(request, env);
  if (auth.response) return auth.response;
  let b;
  try { b = await request.json(); } catch (e) { return fail("That didn't send. Try again.", 400); }
  const text = clip(b && b.text, MAX_TEXT);
  if (text.length < 5) return fail("Write a few words about what went wrong first.", 400);

  const name = clip(auth.user.name, 60) || "someone (not signed in)";
  const now = new Date();
  let org = "";
  try { org = new URL(env.SF_LOGIN_URL || "").host; } catch (e) { org = ""; }
  const report = { text, name, at: now.toISOString(), when: chicagoTime(now), org,
    from: clip(b.from, 200), screen: clip(b.screen, 40), agent: clip(b.agent, 300) };

  const { subject, body } = buildEmail(report);
  const mail = await sendViaSalesforce(env, BUG_REPORT_TO, subject, body);
  if (!mail.ok) console.error("[bug-report] email failed", mail.error);

  let kept = false;
  if (env.CATCHER_KV) {
    try {
      const key = `bugreport:${report.at}:${Math.random().toString(36).slice(2, 8)}`;
      await env.CATCHER_KV.put(key, JSON.stringify({ ...report, emailed: mail.ok, emailError: mail.ok ? undefined : mail.error }), { expirationTtl: KV_TTL });
      kept = true;
    } catch (e) { console.error("[bug-report] KV save failed", e && e.message); }
  }

  if (!mail.ok && !kept) return fail("That didn't send. Try again, or tell Anthony in person.", 502);
  return Response.json({ ok: true, emailed: mail.ok }, { headers: NO_STORE });
}
