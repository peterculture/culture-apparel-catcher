/**
 * POST /api/size-change   { orderId, line, received: { "M": 3, "L": 13, ... }, note, requestId }
 *
 * SIZES CHANGED (11-04): the supplier sent different sizes, the customer OK'd printing what arrived.
 * The catcher types how many of each size arrived for ONE garment; this writes that garment's line in
 * the order's Size Changes field (Size_Changes__c, Long Text), for example
 *   Black Comfort Colors 1717: M 6→3, L 10→13 · Titus, 11/4/2026 · Supplier sent 3 more L and 3 fewer M.
 * and the app then counts that garment against what arrived (see _sizechanges.js).
 *
 *   - Only sizes on the order. A size left out keeps what it has now.
 *   - Every size back to what was ordered = the garment's line is removed (undo).
 *   - A change needs a reason (the "Why?" box), 3 to 200 characters.
 *   - Other garments' lines, and lines typed by hand in Salesforce, are kept as they are.
 *   - Saved only if nobody changed the order since it was read (If-Unmodified-Since), read again up to 3 times.
 *   - The order's products (quantities, prices) are never changed.
 * Answers 200 { ok, order } with the order as the board shows it now.
 */
import { json, errorResponse, sfFetch, apiVersion, sfMessage, sfErrorCode, SF_ID, SfError } from "./_sf.js";
import { requireUser, REQ_ID, rememberResult, withRequestId } from "./_session.js";
import { loadOneOrder, stripItems } from "./_orders.js";
import { SIZE_CHANGES_FIELD, MAX_TEXT, lineLabels, formatLine, replaceLine, shopDate, oneLine } from "./_sizechanges.js";

const HTTP_DATE = (iso) => new Date(iso).toUTCString();

export async function onRequestPost({ request, env }) {
  const auth = await requireUser(request, env);
  if (auth.response) return auth.response;
  try {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") return json({ error: "bad_request", message: "Nothing was sent." }, 400);
    const orderId = String(body.orderId || ""), requestId = String(body.requestId || "");
    const li = body.line;
    const received = body.received && typeof body.received === "object" && !Array.isArray(body.received) ? body.received : null;
    if (!SF_ID.test(orderId) || !Number.isInteger(li) || li < 0 || li > 200 || !received) {
      return json({ error: "bad_request", message: "That didn't send right. Refresh and try again." }, 400);
    }
    for (const k of Object.keys(received)) {
      const n = received[k];
      if (!Number.isInteger(n) || n < 0 || n > 9999) return json({ error: "bad_qty", message: `${String(k).slice(0, 10)}: type a whole number from 0 to 9999.` }, 400);
    }
    if (!REQ_ID.test(requestId)) return json({ error: "bad_request", message: "Refresh the page and try again." }, 400);
    const note = oneLine(body.note, 200);

    return await withRequestId(env, requestId, 200, async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const order = await loadOneOrder(env, orderId);
        if (order.sizeChangesText === null) {
          throw new SfError("not_set_up", 409,
            "Salesforce has no Size Changes field the app can use yet, so nothing was saved. Tell Anthony (tools/catcher-size-changes.apex).");
        }
        const line = order.lines[li];
        if (!line) return json({ error: "bad_line", message: "That garment isn't on this order any more. Refresh the list." }, 404);
        for (const k of Object.keys(received)) {
          if (!line.sizes.some((s) => s.size === k)) return json({ error: "bad_size", message: `This garment has no size ${String(k).slice(0, 10)} on the order. Refresh and try again.` }, 400);
        }
        const pairs = [];
        for (const s of line.sizes) {
          const ordered = s.ordered != null ? s.ordered : s.qty;
          const got = Object.prototype.hasOwnProperty.call(received, s.size) ? received[s.size] : s.qty;
          if (got !== ordered) pairs.push({ size: s.size, ordered, received: got });
        }
        if (pairs.length && note.length < 3) {
          return json({ error: "need_note", message: "Write why the sizes changed (for example: customer OK'd printing what arrived)." }, 400);
        }
        const label = lineLabels(order.lines)[li];
        const newLine = pairs.length ? formatLine(label, pairs, auth.user.name, shopDate(), note) : "";
        const text = replaceLine(order.sizeChangesText, label, newLine);
        if (text.length > MAX_TEXT) return json({ error: "too_long", message: "The order's Size Changes notes are full. Tell a manager." }, 422);
        if (text === String(order.sizeChangesText || "").split(/\r?\n/).map((r) => r.trim()).filter(Boolean).join("\n")) {
          const same = { ok: true, unchanged: true, orderId: order.id, order: stripItems(order) };
          await rememberResult(env, requestId, same);
          return json(same, 200);
        }

        const resp = await sfFetch(env, `/services/data/${apiVersion(env)}/sobjects/Order/${order.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json", "If-Unmodified-Since": HTTP_DATE(order.lastModified) },
          body: JSON.stringify({ [SIZE_CHANGES_FIELD]: text || null }),
        });
        if (resp.status === 412) continue;   // someone changed the order a moment ago: read again, apply on top
        if (resp.status !== 204) {
          const data = await resp.json().catch(() => null);
          console.error("size change save failed", resp.status, sfErrorCode(data), sfMessage(data));
          throw new SfError("save_failed", resp.status >= 500 ? 502 : 422,
            "Salesforce did not save the size change" + (sfMessage(data) ? `: "${sfMessage(data)}"` : ".") + " Nothing was saved.");
        }
        const fresh = await loadOneOrder(env, orderId).catch(() => null);
        const result = { ok: true, orderId: order.id, line: li, pairs, cleared: !pairs.length,
          order: fresh ? stripItems(fresh) : null };
        await rememberResult(env, requestId, result);
        return json(result, 200);
      }
      throw new SfError("busy", 409, "This order kept changing while saving, so nothing was saved. Try again.");
    });
  } catch (err) {
    return errorResponse(err);
  }
}
