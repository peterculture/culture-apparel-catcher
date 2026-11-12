/**
 * The Catch's counts on The Forge's Run Results (11-12, Anthony).
 *
 * "When the items are logged on the staging Catcher app, I need the forge results to pick up the
 * item quantities and add them to its chart." Answers 11-12: the Catch OWNS the count (press
 * operators stop typing counts on The Forge for these runs); counts go over AS EACH BOX IS SAVED;
 * "the second a misprint is logged from the catcher app ... it should show on the run results".
 *
 * THE FORGE IS FROZEN, so nothing on its side changes. It already reads its counts from Salesforce:
 *   Production_Run__c                 a run (Result_Status__c Draft / Submitted)
 *   Production_Run_Line_Item__c       one per size of the run; Order_Product__c = the OrderItem
 *   Run_Result__c                     one per count: Line_Item__c, Good_Qty__c, Misprint_Qty__c,
 *                                     Damaged_Qty__c, Incomplete_Qty__c, Counted_At__c,
 *                                     Counted_By__c, Note__c
 * Salesforce (Apex RunResultRollup) adds the Run Results into the line item's totals, which The
 * Forge's counting screen, reprint check and shortfall list read. So the Catch only has to create
 * the same Run_Result__c rows The Forge's own "add a count" creates (run-results/index.js addCounts).
 *
 * WHICH RUN. Each size the catcher counts is an Order Product the Catch already knows. Its count
 * goes on the size line of the MOST RECENT run of that order that prints that Order Product and is
 * not Submitted (latest Actual Start, else Scheduled Start). That is the run whose garments are
 * coming off the dryer. A Submitted run is final on The Forge (the org refuses changes), so it is
 * skipped; if every run is Submitted or there is no run yet, nothing goes over and the tablet says so.
 *
 *   box saved          Good = the box's count per size (one Run Result per size, per box)
 *   misprint saved     Misprint (or Damaged for "Hole / damaged") with the reason as the note
 *   box edited         its Run Results are deleted and made again from the new counts
 *   box deleted        its Run Results are deleted
 * Extras (Add More) aren't on the order, so they have no run line and stay on the Catch only.
 * Which Run Results belong to which box: KV forge:box:<org>:<boxId> (60 days).
 *
 * SAFETY. The box or misprint is already saved in Salesforce when this runs; a failure here never
 * undoes it or reports it as failed. The answer carries a one-line `forgeNote` for the toast.
 * Only where Run_Result__c exists (dev2 / staging; Production has no Forge objects), and never on
 * Production unless FORGE_RESULTS=on is set there.
 */
import { runQuery, sfFetch, apiVersion, soqlQuote, orgOf, SF_ID } from "./_sf.js";

export const RESULT_OBJECT = "Run_Result__c";
const LINE_OBJECT = "Production_Run_Line_Item__c";
const SUBMITTED = "Submitted";
const NOTE_MAX = 255;
const KEEP_SECONDS = 60 * 24 * 3600;

/* Does this org have The Forge's Run Results? Asked once per org every 10 minutes. */
const layerCache = new Map();   // org -> { at, ok }
export function _resetForge() { layerCache.clear(); }

export function forgeAllowed(env) {
  return orgOf(env) !== "production" || String(env.FORGE_RESULTS || "").toLowerCase() === "on";
}
export async function forgeLayer(env) {
  if (!forgeAllowed(env)) return false;
  const org = orgOf(env);
  const hit = layerCache.get(org);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.ok;
  let ok = false;
  try {
    const r = await sfFetch(env, `/services/data/${apiVersion(env)}/sobjects/${RESULT_OBJECT}/describe`);
    ok = r.ok;
    if (r.body && r.body.cancel) r.body.cancel();
  } catch (_) { ok = false; }
  layerCache.set(org, { at: Date.now(), ok });
  return ok;
}

const when = (l) => String((l.ProductionRun__r && (l.ProductionRun__r.Actual_Start__c || l.ProductionRun__r.Scheduled_Start__c)) || "");

/** OrderItem id -> { lineId, runId, runName } on the most recent run that isn't Submitted. */
export async function openRunLines(env, itemIds) {
  const ids = [...new Set(itemIds.filter((id) => SF_ID.test(String(id || ""))))];
  const out = new Map();
  if (!ids.length) return { lines: out, anyRun: false };
  const rows = await runQuery(env,
    `SELECT Id, Order_Product__c, ProductionRun__c, ProductionRun__r.Name, ProductionRun__r.Result_Status__c, ` +
    `ProductionRun__r.Actual_Start__c, ProductionRun__r.Scheduled_Start__c FROM ${LINE_OBJECT} ` +
    `WHERE Order_Product__c IN (${ids.map(soqlQuote).join(",")})`);
  const key = (id) => String(id || "");   // both sides are 18-character ids straight from Salesforce
  const open = rows.filter((l) => !(l.ProductionRun__r && l.ProductionRun__r.Result_Status__c === SUBMITTED))
    .sort((a, b) => when(b).localeCompare(when(a)));
  for (const l of open) {
    const k = key(l.Order_Product__c);
    if (!out.has(k)) out.set(k, { lineId: l.Id, runId: l.ProductionRun__c, runName: (l.ProductionRun__r && l.ProductionRun__r.Name) || "" });
  }
  return { lines: out, anyRun: rows.length > 0, get: (itemId) => out.get(key(itemId)) || null };
}

/** The OrderItem behind one size of a garment line (server-side order: sizes still carry items). */
export function itemFor(order, lineIdx, size) {
  const line = order && order.lines && order.lines[lineIdx];
  const cell = line && line.sizes.find((s) => s.size === size);
  const it = cell && cell.items && cell.items[0];
  return it ? it.id : null;
}

function clip(s) { return String(s == null ? "" : s).replace(/[\r\n\t]+/g, " ").trim().slice(0, NOTE_MAX); }

/** Create Run Results (sObject Collections, 200 a call, all-or-none per call). Returns created ids per input record. */
async function createResults(env, records) {
  const ids = [];
  for (let i = 0; i < records.length; i += 200) {
    const chunk = records.slice(i, i + 200);
    const resp = await sfFetch(env, `/services/data/${apiVersion(env)}/composite/sobjects`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ allOrNone: true, records: chunk }),
    });
    const data = await resp.json().catch(() => null);
    if (!resp.ok || !Array.isArray(data) || data.some((x) => !x || !x.success)) {
      const errs = Array.isArray(data) ? data.flatMap((x) => (x && x.errors) || []) : [];
      const real = errs.find((e) => e.statusCode !== "ALL_OR_NONE_OPERATION_ROLLED_BACK") || errs[0];
      const e = new Error(real ? String(real.message || real.statusCode) : `HTTP ${resp.status}`);
      e.created = ids;
      throw e;
    }
    ids.push(...data.map((x) => x.id));
  }
  return ids;
}

/** Delete Run Results. true = all gone (or none to delete). */
async function deleteResults(env, ids) {
  const list = ids.filter((id) => SF_ID.test(String(id || "")));
  for (let i = 0; i < list.length; i += 200) {
    const chunk = list.slice(i, i + 200);
    const resp = await sfFetch(env, `/services/data/${apiVersion(env)}/composite/sobjects?allOrNone=true&ids=${chunk.join(",")}`, { method: "DELETE" });
    const data = await resp.json().catch(() => null);
    const ok = resp.ok && Array.isArray(data) && data.every((x) => x && (x.success || (x.errors || []).some((e) => e.statusCode === "ENTITY_IS_DELETED" || e.statusCode === "INVALID_CROSS_REFERENCE_KEY")));
    if (!ok) {
      const errs = Array.isArray(data) ? data.flatMap((x) => (x && x.errors) || []) : [];
      const real = errs.find((e) => e.statusCode !== "ALL_OR_NONE_OPERATION_ROLLED_BACK") || errs[0];
      throw new Error(real ? String(real.message || real.statusCode) : `HTTP ${resp.status}`);
    }
  }
  return true;
}

const boxKey = (env, boxId) => `forge:box:${orgOf(env)}:${boxId}`;
async function readBoxMap(env, boxId) {
  if (!env.CATCHER_KV) return [];
  try { const v = JSON.parse((await env.CATCHER_KV.get(boxKey(env, boxId))) || "null"); return Array.isArray(v) ? v : []; } catch (_) { return []; }
}
async function writeBoxMap(env, boxId, ids) {
  if (!env.CATCHER_KV) return;
  try {
    if (ids.length) await env.CATCHER_KV.put(boxKey(env, boxId), JSON.stringify(ids), { expirationTtl: KEEP_SECONDS });
    else await env.CATCHER_KV.delete(boxKey(env, boxId));
  } catch (e) { console.error("[forge] KV write failed", e && e.message); }
}

const runList = (names) => [...new Set(names.filter(Boolean))].join(", ");
const noRunNote = (anyRun) => anyRun
  ? "Not on the Forge: every run of this order is already submitted (final) there."
  : "Not on the Forge: this order has no production run there yet.";

/**
 * After boxes are saved: one Good Run Result per size, per box, on the open run line.
 * boxes: [{ id, name, counts: [{ line, size, qty, extra? }] }]. Returns the toast line.
 */
export async function forgeAfterBoxes(env, order, boxes, who) {
  try {
    if (!(await forgeLayer(env))) return "";
    const items = [];
    for (const b of boxes) for (const c of b.counts || []) if (!c.extra) items.push(itemFor(order, c.line, c.size));
    if (!items.filter(Boolean).length) return "";
    const map = await openRunLines(env, items);
    const records = [], owner = [], runs = [];
    let skipped = 0;
    const at = new Date().toISOString();
    for (const b of boxes) {
      for (const c of b.counts || []) {
        if (c.extra || !c.qty) continue;
        const hit = map.get(itemFor(order, c.line, c.size));
        if (!hit) { skipped += c.qty; continue; }
        records.push({ attributes: { type: RESULT_OBJECT }, Line_Item__c: hit.lineId, Good_Qty__c: c.qty, Counted_At__c: at,
          ...(who ? { Counted_By__c: clip(who).slice(0, 80) } : {}), Note__c: clip(`The Catch · box ${b.name || ""}`) });
        owner.push(b.id); runs.push(hit.runName);
      }
    }
    if (!records.length) return noRunNote(map.anyRun);
    const ids = await createResults(env, records);
    const per = new Map();
    ids.forEach((id, i) => { if (!per.has(owner[i])) per.set(owner[i], []); per.get(owner[i]).push(id); });
    for (const b of boxes) if (per.has(b.id)) await writeBoxMap(env, b.id, [...(await readBoxMap(env, b.id)), ...per.get(b.id)]);
    const good = records.reduce((a, r) => a + r.Good_Qty__c, 0);
    return `Added ${good} good to the Forge's run results (${runList(runs)}).` + (skipped ? ` ${skipped} had no open run there.` : "");
  } catch (e) {
    console.error("[forge] boxes -> run results failed", e && e.message);
    return `Saved on the Catch, but not added to the Forge's run results: ${String(e && e.message || "Salesforce said no").slice(0, 160)}`;
  }
}

/** After a box is edited: its Run Results are made again from the new counts. */
export async function forgeAfterEdit(env, order, box, who) {
  try {
    if (!(await forgeLayer(env))) return "";
    const old = await readBoxMap(env, box.id);
    if (old.length) {
      try { await deleteResults(env, old); }
      catch (e) { return `The Forge's run results still show the old count for this box (${String(e.message).slice(0, 120)}).`; }
      await writeBoxMap(env, box.id, []);
    }
    const note = await forgeAfterBoxes(env, order, [box], who);
    return note.replace(/^Added /, "Updated on the Forge: ");
  } catch (e) {
    console.error("[forge] edit -> run results failed", e && e.message);
    return "";
  }
}

/** After boxes are deleted: their Run Results go too. */
export async function forgeAfterDelete(env, boxIds) {
  try {
    if (!(await forgeLayer(env))) return "";
    const ids = [];
    for (const id of boxIds) ids.push(...(await readBoxMap(env, id)));
    if (!ids.length) return "";
    try { await deleteResults(env, ids); }
    catch (e) { return `The Forge's run results still count ${boxIds.length === 1 ? "this box" : "these boxes"} (${String(e.message).slice(0, 120)}).`; }
    for (const id of boxIds) await writeBoxMap(env, id, []);
    return "Taken off the Forge's run results too.";
  } catch (e) {
    console.error("[forge] delete -> run results failed", e && e.message);
    return "";
  }
}

/** After a misprint is saved: a Misprint (or Damaged) Run Result with the reason as the note. */
export async function forgeAfterMisprint(env, itemId, { qty, damaged, reason, note, who, size }) {
  try {
    if (!(await forgeLayer(env))) return "";
    if (!itemId) return "Not on the Forge: an extra size has no run line there.";
    const map = await openRunLines(env, [itemId]);
    const hit = map.get(itemId);
    if (!hit) return noRunNote(map.anyRun);
    const rec = { attributes: { type: RESULT_OBJECT }, Line_Item__c: hit.lineId, Counted_At__c: new Date().toISOString(),
      [damaged ? "Damaged_Qty__c" : "Misprint_Qty__c"]: qty,
      Note__c: clip(`The Catch: ${reason}${note ? ": " + note : ""}`),
      ...(who ? { Counted_By__c: clip(who).slice(0, 80) } : {}) };
    await createResults(env, [rec]);
    return `On the Forge's run results now (${hit.runName}, ${size} ${damaged ? "damaged" : "misprinted"} ${qty}).`;
  } catch (e) {
    console.error("[forge] misprint -> run results failed", e && e.message);
    return `Saved on the Catch, but not added to the Forge's run results: ${String(e && e.message || "Salesforce said no").slice(0, 160)}`;
  }
}
