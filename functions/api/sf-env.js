/**
 * GET  /api/sf-env   which Salesforce org this site is on, and (preview site only) which it can switch to.
 * POST /api/sf-env   { env: "dev2" | "staging", pin }   switch the PREVIEW site's org.
 *
 * 11-12 (Anthony): "a Salesforce environment switcher, just like the Forge, so that I can test how
 * the Catcher works with the Forge system" -- as a PREVIEW version of the Catch, so the live site
 * stays on Production. Built like The Forge's /api/admin/sf-env:
 *   - one KV value (sf_env:active) for every tablet on the preview site;
 *   - the switch PIN (SF_ENV_SWITCH_PIN) is asked for every time;
 *   - the new org's login is tried BEFORE switching; if it fails nothing changes.
 * The Catch's own rules on top:
 *   - only where SF_ENV_SWITCH=on (the preview site). The live site answers switchable:false and
 *     refuses every POST, so the floor's tablets can never be moved off Production;
 *   - Production can't be picked on the preview site at all (see isSelectable in _sf.js);
 *   - a signed-in catcher only, and wrong switch PINs count toward the same 5-minute PIN brake as
 *     signing in.
 *
 * GET needs no sign-in: the PIN screen shows "PREVIEW · STAGING" before anyone signs in.
 */
import { json, errorResponse, SF_ENVIRONMENTS, activeOrg, setActiveOrg, homeOrg, orgLabel, switchOn,
  isOrgConfigured, isSelectable, testOrgLogin } from "./_sf.js";
import { requireUser, safeEqual, pinLocked, notePinFail, clearPinFails } from "./_session.js";

export async function onRequestGet({ env }) {
  try {
    const active = await activeOrg(env);
    const switchable = switchOn(env);
    return json({
      active, label: orgLabel(active), home: homeOrg(env), switchable,
      environments: switchable ? SF_ENVIRONMENTS.map((e) => ({
        key: e.key, label: e.label, active: e.key === active,
        configured: isOrgConfigured(env, e.key), selectable: isSelectable(env, e.key),
      })) : [],
    });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function onRequestPost({ request, env }) {
  const auth = await requireUser(request, env);
  if (auth.response) return auth.response;
  try {
    if (!switchOn(env)) {
      return json({ error: "switch_off", message: "This is the live Catch. It always uses Production and can't be switched." }, 403);
    }
    if (await pinLocked(request, env)) {
      return json({ error: "locked", message: "Too many wrong PINs. Wait 5 minutes, then try again." }, 429);
    }
    const body = await request.json().catch(() => null);
    const target = String((body && body.env) || "").trim().toLowerCase();
    const pin = String((body && body.pin) == null ? "" : body.pin);
    if (!SF_ENVIRONMENTS.some((e) => e.key === target)) return json({ error: "unknown_env", message: "Pick Dev2 or Staging." }, 400);
    if (target === "production") {
      return json({ error: "org_not_selectable", message: "The preview can't use Production. The live Catch is the Production one." }, 409);
    }
    if (!isOrgConfigured(env, target)) {
      return json({ error: "env_not_configured", message: `${orgLabel(target)} has no login set up on this site yet (SF_ENV_${target.toUpperCase()}_* secrets).` }, 409);
    }
    if (!env.SF_ENV_SWITCH_PIN || !env.CATCHER_KV) {
      return json({ error: "switch_not_set_up", message: "Switching isn't set up on this site (SF_ENV_SWITCH_PIN and the CATCHER_KV binding)." }, 500);
    }
    if (!pin || !safeEqual(pin, String(env.SF_ENV_SWITCH_PIN))) {
      await notePinFail(request, env);
      return json({ error: "wrong_pin", message: "That switch PIN didn't match." }, 401);
    }
    await clearPinFails(request, env);

    const before = await activeOrg(env);
    if (before === target) return json({ ok: true, active: target, label: orgLabel(target), unchanged: true });

    // Prove the login works BEFORE moving every preview tablet to it (The Forge's AU-5 rule).
    const login = await testOrgLogin(env, target);
    if (!login.ok) {
      return json({ error: "env_login_failed", message: `${orgLabel(target)} refused the app's login, so nothing was switched. ${login.message || ""}`.trim() }, 502);
    }
    await setActiveOrg(env, target);
    console.log(`[sf-env] ${auth.user.name} switched the preview from ${before} to ${target}`);
    return json({ ok: true, active: target, label: orgLabel(target), before });
  } catch (err) {
    return errorResponse(err);
  }
}
