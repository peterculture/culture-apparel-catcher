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
 * Answers 201 only after Salesforce has confirmed the record exists.
 */
import { json, errorResponse, sfFetch, apiVersion, picklistValues, sfMessage, sfErrorCode, SF_ID, SfError } from "./_sf.js";
import { requireUser, REQ_ID, rememberResult, withRequestId } from "./_session.js";
import { loadOneOrder } from "./_orders.js";
import { SIZE_FIELD, buildBreakdown } from "./_sizes.js";

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

    if (!SF_ID.test(orderId)) return json({ error: "bad_order_id", message: "That order is not valid. Refresh the list." }, 400);
    if (counts) {
      if (counts.length > 80) return json({ error: "bad_counts", message: "Too many sizes in one box. Split it into two boxes." }, 400);
      for (const c of counts) {
        if (!c || !Number.isInteger(c.line) || typeof c.size !== "string" || !Number.isInteger(c.qty) || c.qty < 0 || c.qty > 9999) {
          return json({ error: "bad_counts", message: "A size count isn't a whole number. Check the counts and try again." }, 400);
        }
      }
      qty = counts.reduce((a, c) => a + c.qty, 0);
    }
    if (!Number.isInteger(qty) || qty < 1 || qty > 9999) return json({ error: "bad_qty", message: "Enter how many garments are in the box (1 to 9999)." }, 400);
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
      const seen = new Set();
      for (const c of counts) {
        const line = order.lines[c.line];
        if (!line || !line.sizes.some((s) => s.size === c.size)) {
          return json({ error: "bad_size", message: `"${String(c.size).slice(0, 12)}" isn't a size on this order. Refresh and try again.` }, 400);
        }
        const k = c.line + "|" + c.size;
        if (seen.has(k)) return json({ error: "bad_counts", message: "The same size was sent twice. Try again." }, 400);
        seen.add(k);
        if (c.qty) clean.push({ line: c.line, size: c.size, qty: c.qty });
      }
      try { breakdown = buildBreakdown(order.lines, clean).text; } catch (e) {
        return json({ error: "too_long", message: e.message }, 400);
      }
    }

    const resp = await sfFetch(env, `/services/data/${apiVersion(env)}/sobjects/Order_Packaging__c`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        Name: boxName,
        Order__c: order.id,
        Packaging_Type__c: type,
        Packaging_Quantity__c: qty,
        ...(breakdown ? { [SIZE_FIELD]: breakdown } : {}),
      }),
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
