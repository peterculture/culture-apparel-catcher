/**
 * POST /api/boxes   { orderId, type, name, counts: [{ line, size, qty }], requestId }
 *
 * Logs ONE packed box: creates one Order_Packaging__c record (the same record the
 * "Enter Packaging" flow V3 and the dashboard create):
 *   Name                      "Garment Type", e.g. "Tees 3" (what is in the box + its number)
 *   Order__c                  the order
 *   Packaging_Type__c         "Packaging Type", the box used
 *   Packaging_Quantity__c     the box's TOTAL garments (a number, as before)
 *   Quantity_Size_Counted__c  "Quantity + Size Counted", e.g. "S 8 · M 15 · L 17 · XL 10 = 50"
 * The total is added up here from the size counts, so it can't disagree with them.
 * One box may hold several garments from the order. Number of boxes = number of records.
 * (An older tablet that still sends only { qty } is accepted, saved without sizes.)
 *
 * BOXES LIKE THIS (11-02)  { ..., copies: 2-100 }: the same box is saved `copies` times at once, so a
 * catcher doesn't have to save one and then Duplicate it. Same rules as Duplicate Box: every record in ONE
 * Salesforce request with allOrNone (all are created or none), numbered on from the boxes already on the
 * order ("Crewnecks 4", "Crewnecks 5", ...), each credited to the catcher. copies 1 (or left out) = as before.
 *
 * Answers 201 only after Salesforce has confirmed the record(s) exist.
 */
import { json, errorResponse, sfFetch, apiVersion, picklistValues, sfMessage, sfErrorCode, SF_ID, SfError } from "./_sf.js";
import { requireUser, REQ_ID, rememberResult, withRequestId } from "./_session.js";
import { loadOneOrder } from "./_orders.js";
import { boxFields, countsShapeError, checkCounts, garmentWord, nextNames } from "./_boxes.js";
import { MAX_DUPLICATES } from "./duplicate-box.js";

export async function onRequestPost({ request, env }) {
  const auth = await requireUser(request, env);
  if (auth.response) return auth.response;
  try {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") return json({ error: "bad_request", message: "Nothing was sent." }, 400);

    const orderId = String(body.orderId || "");
    const type = String(body.type || "");
    const counts = Array.isArray(body.counts) ? body.counts : null;
    let qty = Number(body.qty);
    const name = String(body.name || "").replace(/\s+/g, " ").trim().slice(0, 80);
    const requestId = String(body.requestId || "");
    const copies = body.copies === undefined ? 1 : body.copies;

    if (!SF_ID.test(orderId)) return json({ error: "bad_order_id", message: "That order is not valid. Refresh the list." }, 400);
    if (counts) {
      const bad = countsShapeError(counts);
      if (bad) return json({ error: "bad_counts", message: bad }, 400);
      qty = counts.reduce((a, c) => a + c.qty, 0);
    }
    if (!Number.isInteger(qty) || qty < 1 || qty > 9999) return json({ error: "bad_qty", message: "Enter how many garments are in the box (1 to 9999)." }, 400);
    if (!Number.isInteger(copies) || copies < 1 || copies > MAX_DUPLICATES) {
      return json({ error: "bad_copies", message: `Boxes like this: enter a whole number from 1 to ${MAX_DUPLICATES}.` }, 400);
    }
    if (!REQ_ID.test(requestId)) return json({ error: "bad_request", message: "Refresh the page and try again." }, 400);

    return await withRequestId(env, requestId, 201, async () => {
    const types = await picklistValues(env, "Order_Packaging__c", "Packaging_Type__c");
    if (!types.some((t) => t.value === type)) {
      return json({ error: "bad_type", message: "Pick a box type from the list." }, 400);
    }

    // The order must still be one the catchers are allowed to see.
    const order = await loadOneOrder(env, orderId);
    const boxName = name || `${type} ${order.boxes.length + 1}`;

    // Every size counted must be a size of that garment on this order.
    let breakdown = "";
    let clean = [];
    if (counts) {
      const checked = checkCounts(order, counts);
      if (checked.error) return json({ error: checked.error, message: checked.message }, 400);
      ({ clean, breakdown } = checked);
    }

    if (copies > 1) return await saveMany({ env, auth, order, requestId, type, qty, breakdown, clean, word: garmentWord(boxName), copies });

    const resp = await sfFetch(env, `/services/data/${apiVersion(env)}/sobjects/Order_Packaging__c`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(boxFields({ orderId: order.id, name: boxName, type, qty, breakdown, countedBy: auth.user.name })),
    });
    const data = await resp.json().catch(() => null);
    if (resp.status !== 201 || !data || !data.id || data.success === false) {
      console.error("box create failed", resp.status, sfErrorCode(data), sfMessage(data));
      throw new SfError("save_failed", resp.status >= 500 ? 502 : 422,
        "Salesforce did not save the box" + (sfMessage(data) ? `: "${sfMessage(data)}"` : ".") + " Nothing was saved.");
    }

    const result = {
      ok: true,
      box: { id: data.id, name: boxName, type, qty, sizes: breakdown, counts: clean, by: auth.user.name, at: new Date().toISOString() },
      orderId: order.id,
      boxCount: order.boxes.length + 1,
      boxed: order.boxes.reduce((a, b) => a + b.qty, 0) + qty,
    };
    await rememberResult(env, requestId, result);
    return json(result, 201);
    });
  } catch (err) {
    return errorResponse(err);
  }
}

/** BOXES LIKE THIS: `copies` identical boxes in one all-or-nothing request (same as Duplicate Box). */
async function saveMany({ env, auth, order, requestId, type, qty, breakdown, clean, word, copies }) {
  const names = nextNames(order.boxes, word, copies);
  const records = names.map((name) => Object.assign({ attributes: { type: "Order_Packaging__c" } },
    boxFields({ orderId: order.id, name, type, qty, breakdown, countedBy: auth.user.name })));
  const resp = await sfFetch(env, `/services/data/${apiVersion(env)}/composite/sobjects`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ allOrNone: true, records }),
  });
  const data = await resp.json().catch(() => null);
  const results = Array.isArray(data) ? data : [];
  const at = new Date().toISOString();
  const made = [];
  results.forEach((r, i) => { if (r && r.success && r.id && SF_ID.test(r.id)) made.push({ id: r.id, name: names[i], type, qty, sizes: breakdown, counts: clean, by: auth.user.name, at }); });
  if (resp.status !== 200 || made.length !== copies) {
    const firstErr = results.map((r) => r && r.errors && r.errors[0]).find((e) => e && e.message && e.statusCode !== "ALL_OR_NONE_OPERATION_ROLLED_BACK");
    const why = (firstErr && firstErr.message) || sfMessage(data) || "";
    console.error("boxes-like-this failed", resp.status, made.length, "of", copies, why);
    if (made.length) {
      // Shouldn't happen with allOrNone, but if Salesforce ever reports it, say exactly what exists.
      const partial = { ok: false, error: "partial", created: made.length, failed: copies - made.length, boxes: made,
        message: `${made.length} of ${copies} boxes were saved; ${copies - made.length} were not` + (why ? `: "${why}"` : ".") + " Nothing was retried." };
      await rememberResult(env, requestId, partial);
      return json(partial, 207);
    }
    throw new SfError("save_failed", resp.status >= 500 ? 502 : 422,
      "Salesforce did not save the boxes" + (why ? `: "${why}"` : ".") + ` None of the ${copies} were saved.`);
  }
  const result = { ok: true, box: made[0], boxes: made, created: copies, orderId: order.id,
    boxCount: order.boxes.length + copies, boxed: order.boxes.reduce((a, b) => a + b.qty, 0) + qty * copies };
  await rememberResult(env, requestId, result);
  return json(result, 201);
}
