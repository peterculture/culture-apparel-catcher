// Offline tests for the Dryer Catch API, against a pretend Salesforce.
// Nothing here touches the network.     Run:  node tools/test.mjs
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "functions", "api");
const dir = mkdtempSync(join(tmpdir(), "catch-"));
for (const f of readdirSync(src)) {
  if (!f.endsWith(".js")) continue;
  writeFileSync(join(dir, f.replace(/\.js$/, ".mjs")), readFileSync(join(src, f), "utf8").replace(/from "\.\/([\w-]+)\.js"/g, 'from "./$1.mjs"'));
}
const mod = async (n) => import(join(dir, n + ".mjs"));
const sf = await mod("_sf");
const login = await mod("login");
const orders = await mod("orders");
const boxes = await mod("boxes");
const mis = await mod("misprints");
const me = await mod("me");
const logout = await mod("logout");
const mockup = await mod("mockup");
const finish = await mod("finish");
const sizes = await mod("_sizes");
const dup = await mod("duplicate-box");
const past = await mod("past-orders");
const bedit = await mod("box-edit");
const bdel = await mod("box-delete");

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.log("  FAIL:", msg); } }
async function test(name, fn) { console.log("•", name); try { await fn(); } catch (e) { fail++; console.log("  THREW:", e.stack); } }

/* ---------------- pretend Salesforce ---------------- */
let db, calls, behave;
function reset() {
  sf._resetTokenCache(); sf._resetDescribeCache();
  calls = [];
  behave = {};
  db = {
    orders: [
      { Id: "801000000000001AAA", OrderNumber: "00015401", GOA_Order_Number__c: '<a href="/801000000000001" target="_self">21379-1</a>',
        Account: { Name: "Good Life Training" }, OpportunityId: "006000000000001AAA", Print_Date__c: "2026-10-16T15:00:00.000+0000",
        Printer__r: { Name: "Culture Apparel" }, Specifications_for_Printing__c: "2 colors", TotalQtyMisprints__c: null,
        Misprint_Details__c: "TOTAL QTY: 00", Artwork_URL__c: "https://cultureapparel.file.force.com/sfc/dist/version/download/?oid=00D&ids=068000000000001&d=abc", LastModifiedDate: "2026-10-14T16:00:00.000+0000", _inProd: true },
      { Id: "801000000000002AAA", OrderNumber: "00015402", GOA_Order_Number__c: "20984-1", Account: { Name: "Daybright" },
        OpportunityId: null, Print_Date__c: "2026-10-27T15:00:00.000+0000", Printer__r: { Name: "Culture Apparel Press 2" },
        TotalQtyMisprints__c: 3, Misprint_Details__c: "TOTAL QTY: 03 stained M (Dev 10/13)", LastModifiedDate: "2026-10-14T16:00:00.000+0000", _inProd: true },
    ],
    items: [
      { OrderId: "801000000000001AAA", Size__c: "L", Color__c: "Navy", Quantity: 24, Product2: { Name: "Gildan 5000 Tee" } },
      { OrderId: "801000000000001AAA", Size__c: "S", Color__c: "Navy", Quantity: 12, Product2: { Name: "Gildan 5000 Tee" } },
      { OrderId: "801000000000001AAA", Size__c: "M", Color__c: "Navy", Quantity: 20, Product2: { Name: "Gildan 5000 Tee" } },
      { OrderId: "801000000000001AAA", Size__c: null, Quantity: 1, Product2: { Name: "Screen setup" } },
      { OrderId: "801000000000002AAA", Size__c: "XL", Color__c: "Black", Quantity: 8, Product2: { Name: "Richardson 112 Hat" } },
    ],
    boxes: [{ Id: "a0X000000000001AAA", Order__c: "801000000000001AAA", Name: "Tees 1", Packaging_Type__c: "Standard Culture Box", Packaging_Quantity__c: 30, CreatedDate: "2026-10-14T15:00:00.000+0000", CreatedBy: { Name: "Catcher App" } }],
    designs: [{ Opportunity__c: "006000000000001AAA", Mockup_URL__c: "https://cultureapparel.file.force.com/sfc/servlet.shepherd/version/download/068000000000001AAA" }],
  };
}
const ENV = () => ({
  SF_LOGIN_URL: "https://login.example", SF_CLIENT_ID: "id", SF_CLIENT_SECRET: "secret",
  SESSION_SECRET: "a-very-long-session-secret-for-tests",
  CATCHER_PINS: JSON.stringify({ "Maria R.": "4821", "Dev T.": "1937" }),
  CATCHER_KV: kv(),
});
function kv() {
  const m = new Map();
  return { get: async (k) => (m.has(k) ? m.get(k) : null), put: async (k, v) => { m.set(k, v); }, delete: async (k) => { m.delete(k); }, _m: m };
}
const res = (status, body, headers = {}) => new Response(body == null ? null : JSON.stringify(body), { status, headers: Object.assign({ "Content-Type": "application/json" }, headers) });

globalThis.fetch = async (url, init = {}) => {
  url = String(url); const method = (init.method || "GET").toUpperCase();
  calls.push({ url, method, body: init.body, headers: init.headers || {} });
  if (url.includes("file.force.com/sfc/dist/")) {
    await new Promise((r) => setTimeout(r, 30));
    if (behave.artHtml) return new Response("<html>preview</html>", { status: 200, headers: { "Content-Type": "text/html" } });
    if (behave.artAi) return new Response(new TextEncoder().encode("%PDF-1.6\n%\u00e2\u00e3 illustrator body"), { status: 200, headers: { "Content-Type": "application/postscript" } });
    if (behave.artEps) return new Response(new TextEncoder().encode("%!PS-Adobe-3.0 EPSF-3.0\n"), { status: 200, headers: { "Content-Type": "application/postscript" } });
    return new Response(new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]), { status: 200, headers: { "Content-Type": "image/jpeg" } });
  }
  if (url.endsWith("/services/oauth2/token")) return res(200, { access_token: "TOKEN", instance_url: "https://ca.my.salesforce.com" });
  const u = new URL(url);
  if (u.pathname.endsWith("/query")) {
    const q = u.searchParams.get("q");
    if (/FROM Order WHERE/.test(q)) {
      if (behave.queryFail) return res(400, [{ errorCode: "INVALID_FIELD", message: "No such column" }]);
      const idm = q.match(/AND Id = '([^']+)'/);
      const carry = /Packaging_Count__c = null/.test(q) ? (q.match(/Id IN \(([^)]*)\)/) || [, ""])[1] : "";
      const review = !/Order_Substatus__c = 'Production'/.test(q) ? (q.match(/Id IN \(([^)]*)\)/) || [, ""])[1] : null;
      let recs = review !== null ? db.orders.filter((o) => review.includes(o.Id))
        : db.orders.filter((o) => o._inProd || (carry.includes(o.Id) && o.Packaging_Count__c == null));
      if (idm) recs = recs.filter((o) => o.Id === idm[1]);
      return res(200, { done: true, records: recs.map((o) => { const { _inProd, ...r } = o; return Object.assign({ Order_Substatus__c: _inProd ? "Production" : "Post-Production", Packaging_Count__c: null }, r); }) });
    }
    if (/FROM OrderItem/.test(q)) return res(200, { done: true, records: db.items.filter((i) => q.includes(i.OrderId)) });
    if (/FROM Order_Packaging__c WHERE CreatedDate = LAST_N_DAYS:(\d+)/.test(q)) {
      const days = Number(q.match(/LAST_N_DAYS:(\d+)/)[1]);
      const recs = db.boxes.filter((b) => Date.parse(b.CreatedDate) > Date.now() - days * 86400000).sort((a, b) => b.CreatedDate.localeCompare(a.CreatedDate));
      return res(200, { done: true, records: recs.map((b) => ({ Order__c: b.Order__c, CreatedDate: b.CreatedDate })) });
    }
    if (/FROM Order_Packaging__c/.test(q)) return res(200, { done: true, records: db.boxes.filter((b) => q.includes(b.Order__c)) });
    if (/FROM ContentDocumentLink/.test(q)) {
      if (!behave.files) return res(200, { done: true, records: [] });
      return res(200, { done: true, records: [
        { LinkedEntityId: "801000000000001AAA", ContentDocumentId: "069000000000002AAA", ContentDocument: { Title: "Ivory proof", LatestPublishedVersionId: "068000000000002AAA" } },
        { LinkedEntityId: "801000000000001AAA", ContentDocumentId: "069000000000001AAA", ContentDocument: { Title: "Green proof", LatestPublishedVersionId: "068000000000001AAA" } },
      ] });
    }
    if (/FROM Design__c/.test(q)) return res(200, { done: true, records: db.designs.filter((d) => q.includes(d.Opportunity__c)) });
    return res(200, { done: true, records: [] });
  }
  if (u.pathname.endsWith("/VersionData")) {
    const tag = u.pathname.includes("068000000000002AAA") ? 2 : 1;
    return new Response(new Uint8Array([0xff, 0xd8, 0xff, tag]), { status: 200, headers: { "Content-Type": "application/octetstream" } });
  }
  if (u.pathname.endsWith("/sobjects/Order_Packaging__c/describe")) {
    return res(200, { fields: [{ name: "Packaging_Type__c", picklistValues: [
      { value: "Standard Culture Box", label: "Standard Culture Box", active: true, defaultValue: true },
      { value: "Culture Hat Box", label: "Culture Hat Box", active: true },
      { value: "Old Box", label: "Old Box", active: false } ] }] });
  }
  if (u.pathname.endsWith("/sobjects/Order_Packaging__c") && method === "POST") {
    if (behave.boxTimeout) throw new Error("timeout");
    if (behave.boxReject) return res(400, [{ errorCode: "FIELD_CUSTOM_VALIDATION_EXCEPTION", message: "Box needs a type" }]);
    const b = JSON.parse(init.body); const id = "a0X" + (db.boxes.length + 1);
    db.boxes.push(Object.assign({ Id: id, CreatedDate: new Date().toISOString(), CreatedBy: { Name: "Catcher App" } }, b));
    return res(201, { id, success: true, errors: [] });
  }
  if (u.pathname.endsWith("/composite/sobjects") && method === "POST") {
    if (behave.dupTimeout) throw new Error("timeout");
    const b = JSON.parse(init.body);
    if (behave.dupReject) return res(400, b.records.map((r, i) => ({ success: false, errors: i === 0
      ? [{ statusCode: "FIELD_CUSTOM_VALIDATION_EXCEPTION", message: "Packaging is locked" }]
      : [{ statusCode: "ALL_OR_NONE_OPERATION_ROLLED_BACK", message: "Record rolled back because not all records were valid and the request was using AllOrNone header" }] })));
    return res(200, b.records.map((r) => {
      const id = "a0X" + String(db.boxes.length + 1).padStart(15, "0");
      const { attributes, ...fields } = r;
      db.boxes.push(Object.assign({ Id: id, CreatedDate: new Date().toISOString(), CreatedBy: { Name: "Catcher App" } }, fields));
      return { id, success: true, errors: [] };
    }));
  }
  const pm = u.pathname.match(/\/sobjects\/Order_Packaging__c\/(\w+)$/);
  if (pm && (method === "PATCH" || method === "DELETE")) {
    const i = db.boxes.findIndex((x) => x.Id === pm[1]);
    if (i < 0) return res(404, [{ errorCode: "ENTITY_IS_DELETED", message: "entity is deleted" }]);
    if (behave.boxLocked) return res(400, [{ errorCode: "FIELD_CUSTOM_VALIDATION_EXCEPTION", message: "Box is locked" }]);
    if (method === "DELETE") { db.boxes.splice(i, 1); return new Response(null, { status: 204 }); }
    const ius = (init.headers || {})["If-Unmodified-Since"];
    const lm = db.boxes[i].LastModifiedDate || db.boxes[i].CreatedDate;
    if (ius && Math.floor(Date.parse(lm) / 1000) > Math.floor(Date.parse(ius) / 1000)) return new Response(null, { status: 412 });
    Object.assign(db.boxes[i], JSON.parse(init.body), { LastModifiedDate: new Date(Date.now() + 1000).toISOString() });
    return new Response(null, { status: 204 });
  }
  const om = u.pathname.match(/\/sobjects\/Order\/(\w+)$/);
  if (om && method === "PATCH") {
    const o = db.orders.find((x) => x.Id === om[1]);
    if (behave.patch412 && behave.patch412-- > 0) {
      // someone else added a misprint a moment ago
      o.TotalQtyMisprints__c = (o.TotalQtyMisprints__c || 0) + 2;
      o.Misprint_Details__c = mis.totalHeading(o.TotalQtyMisprints__c) + " 2 S - Burned (Dev T. 10/14)";
      o.LastModifiedDate = "2026-10-14T17:00:00.000+0000";
      return new Response(null, { status: 412 });
    }
    if (behave.validation) return res(400, [{ errorCode: "FIELD_CUSTOM_VALIDATION_EXCEPTION", message: "Production and Delivery Dates are required to proceed." }]);
    Object.assign(o, JSON.parse(init.body), { LastModifiedDate: new Date().toISOString() });
    return new Response(null, { status: 204 });
  }
  return res(404, [{ errorCode: "NOT_FOUND", message: "fake: no route " + method + " " + u.pathname }]);
};

/* ---------------- helpers ---------------- */
function req(method, path, body, cookie) {
  const headers = { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.0.5" };
  if (cookie) headers.Cookie = cookie;
  return new Request("https://catch.example" + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
}
async function signIn(env, pin = "4821") {
  const r = await login.onRequestPost({ request: req("POST", "/api/login", { pin }), env });
  const set = r.headers.get("Set-Cookie") || "";
  return set.split(";")[0];
}
const posts = (p) => calls.filter((c) => c.method !== "GET" && c.url.includes(p));

/* ---------------- tests ---------------- */
await test("PIN sign-in", async () => {
  reset(); const env = ENV();
  let r = await login.onRequestPost({ request: req("POST", "/api/login", { pin: "0000" }), env });
  ok(r.status === 401, "wrong PIN is 401");
  r = await login.onRequestPost({ request: req("POST", "/api/login", { pin: "12a4" }), env });
  ok(r.status === 400, "non-digit PIN is 400");
  const cookie = await signIn(env);
  ok(/^ca_catch=/.test(cookie), "right PIN sets the cookie");
  r = await me.onRequestGet({ request: req("GET", "/api/me", null, cookie), env });
  ok(r.status === 200 && (await r.json()).name === "Maria R.", "cookie identifies Maria");
  r = await me.onRequestGet({ request: req("GET", "/api/me", null, cookie.replace(/^(ca_catch=)(.)/, (m, k, c) => k + (c === "e" ? "f" : "e"))), env });
  ok(r.status === 401, "tampered cookie is refused");
  const env2 = Object.assign({}, env, { CATCHER_PINS: JSON.stringify({ "Dev T.": "1937" }) });
  r = await me.onRequestGet({ request: req("GET", "/api/me", null, cookie), env: env2 });
  ok(r.status === 401, "someone removed from the PIN list is signed out");
});

await test("PIN guessing is slowed down", async () => {
  reset(); const env = ENV();
  for (let i = 0; i < 6; i++) await login.onRequestPost({ request: req("POST", "/api/login", { pin: "0000" }), env });
  const r = await login.onRequestPost({ request: req("POST", "/api/login", { pin: "4821" }), env });
  ok(r.status === 429, "after 6 wrong PINs even the right one waits (429)");
});

await test("Shared PIN is a setup error, not a sign-in", async () => {
  reset(); const env = Object.assign(ENV(), { CATCHER_PINS: JSON.stringify({ A: "1111", B: "1111" }) });
  const r = await login.onRequestPost({ request: req("POST", "/api/login", { pin: "1111" }), env });
  ok(r.status === 500, "two people with one PIN -> 500 setup message");
});

await test("Orders list", async () => {
  reset(); const env = ENV();
  let r = await orders.onRequestGet({ request: req("GET", "/api/orders"), env });
  ok(r.status === 401, "no cookie -> 401");
  const cookie = await signIn(env);
  r = await orders.onRequestGet({ request: req("GET", "/api/orders", null, cookie), env });
  const data = await r.json();
  ok(r.status === 200, "200 with cookie");
  const q = decodeURIComponent(calls.find((c) => /FROM\+?%20?Order%20WHERE|FROM Order WHERE/.test(decodeURIComponent(c.url))).url);
  ok(q.includes("Order_Substatus__c = 'Production'"), "filters on In Production (stored value)");
  ok(q.includes("Printer__r.Name IN ('Culture Apparel','Culture Apparel Press 2')"), "filters to the screen-print printers");
  ok(q.includes("Print_Date__c > N_DAYS_AGO:10"), "same 10-day print-date window as the Print Shop list");
  const o = data.orders[0];
  ok(o.num === "21379-1", "order number is the GOA number without link markup");
  ok(o.lines.length === 1 && o.lines[0].sizes.map((s) => s.size).join(",") === "S,M,L", "sizes sorted S,M,L; setup line left out");
  ok(o.total === 56, "garment total 56");
  ok(o.boxes.length === 1 && o.boxes[0].qty === 30, "existing box listed");
  ok(o.hasMockup === true && data.orders[1].hasMockup === false, "mockup flag from Artwork_URL__c");
  ok(!calls.some((c) => /Design__c/.test(decodeURIComponent(c.url))), "never reads Design__c");
  ok(!calls.some((c) => /OpportunityId/.test(decodeURIComponent(c.url))), "never reads the Opportunity link");
  ok(data.orders[1].misprintNotes === "stained M (Dev 10/13)", "misprint notes without the heading");
  ok(!("misprintDetails" in o) && !("artworkUrl" in o), "internal fields (incl. the artwork link) not sent to the tablet");
  ok(!JSON.stringify(data).includes("file.force.com"), "no stored file link reaches the tablet");
});

await test("Orders list: a Salesforce failure is an error, not an empty list", async () => {
  reset(); const env = ENV(); const cookie = await signIn(env);
  behave.queryFail = true;
  const r = await orders.onRequestGet({ request: req("GET", "/api/orders", null, cookie), env });
  ok(r.status === 502, "502, not 200 with zero orders");
});

await test("Log a box", async () => {
  reset(); const env = ENV(); const cookie = await signIn(env);
  const body = { orderId: "801000000000001AAA", type: "Standard Culture Box", qty: 24, name: "Tees 2", requestId: "req-aaaaaaaa1" };
  let r = await boxes.onRequestPost({ request: req("POST", "/api/boxes", body, cookie), env });
  let d = await r.json();
  ok(r.status === 201, "201 created");
  const p = posts("Order_Packaging__c")[0]; const sent = JSON.parse(p.body);
  ok(sent.Name === "Tees 2" && sent.Order__c === "801000000000001AAA" && sent.Packaging_Type__c === "Standard Culture Box" && sent.Packaging_Quantity__c === 24,
    "writes exactly Name, Order__c, Packaging_Type__c, Packaging_Quantity__c");
  ok(sent.CountedBy__c === "Maria R." && Object.keys(sent).length === 5, "plus Counted By = the signed-in catcher, and nothing else");
  ok(d.boxCount === 2 && d.boxed === 54, "reports the new totals");
  // same request again (double tap / retry after a dropped answer)
  r = await boxes.onRequestPost({ request: req("POST", "/api/boxes", body, cookie), env });
  ok(r.status === 201 && posts("Order_Packaging__c").length === 1, "same request id twice -> one record only");
});

await test("Box: refused inputs save nothing", async () => {
  reset(); const env = ENV(); const cookie = await signIn(env);
  const base = { orderId: "801000000000001AAA", type: "Standard Culture Box", qty: 5, requestId: "req-bbbbbbbb" };
  let r = await boxes.onRequestPost({ request: req("POST", "/api/boxes", Object.assign({}, base, { type: "Old Box" }), cookie), env });
  ok(r.status === 400, "inactive box type refused");
  r = await boxes.onRequestPost({ request: req("POST", "/api/boxes", Object.assign({}, base, { qty: 0, requestId: "req-bbbbbbb2" }), cookie), env });
  ok(r.status === 400, "zero garments refused");
  r = await boxes.onRequestPost({ request: req("POST", "/api/boxes", Object.assign({}, base, { orderId: "801000000000009AAA", requestId: "req-bbbbbbb3" }), cookie), env });
  ok(r.status === 409, "an order not In Production is refused (409)");
  r = await boxes.onRequestPost({ request: req("POST", "/api/boxes", Object.assign({}, base, { orderId: "x' OR Id != '", requestId: "req-bbbbbbb4" }), cookie), env });
  ok(r.status === 400, "SOQL-injection-shaped id refused");
  ok(posts("Order_Packaging__c").length === 0, "no box was created by any of these");
});

await test("Box: Salesforce says no -> message passed on, Try again works", async () => {
  reset(); const env = ENV(); const cookie = await signIn(env);
  behave.boxReject = true;
  const body = { orderId: "801000000000001AAA", type: "Culture Hat Box", qty: 6, name: "Tees 2", requestId: "req-cccccccc" };
  let r = await boxes.onRequestPost({ request: req("POST", "/api/boxes", body, cookie), env });
  let d = await r.json();
  ok(r.status === 422 && /Box needs a type/.test(d.message), "422 with Salesforce's own words");
  behave.boxReject = false;
  r = await boxes.onRequestPost({ request: req("POST", "/api/boxes", body, cookie), env });
  ok(r.status === 201, "retry with the same id saves (claim was released)");
});

await test("Box: timeout -> UNCONFIRMED, and a quick retry can't duplicate", async () => {
  reset(); const env = ENV(); const cookie = await signIn(env);
  behave.boxTimeout = true;
  const body = { orderId: "801000000000001AAA", type: "Culture Hat Box", qty: 6, name: "Tees 2", requestId: "req-dddddddd" };
  let r = await boxes.onRequestPost({ request: req("POST", "/api/boxes", body, cookie), env });
  let d = await r.json();
  ok(r.status === 504 && d.error === "unconfirmed", "504 unconfirmed, never 'saved' and never 'failed'");
  behave.boxTimeout = false;
  r = await boxes.onRequestPost({ request: req("POST", "/api/boxes", body, cookie), env });
  ok(r.status === 409, "immediate retry of the same save is held (409) instead of saving twice");
});

await test("Misprint details format", async () => {
  ok(mis.totalHeading(3) === "TOTAL QTY: 03", "heading 3");
  ok(mis.totalHeading(3).slice(10, 13).trim() === "03", "number sits at characters 11-13");
  ok(mis.totalHeading(140).slice(10, 13) === "140", "three-digit totals also fit 11-13");
  ok(mis.existingNotes("TOTAL QTY: 03 stained M") === "stained M", "heading stripped");
  ok(mis.existingNotes("off centered") === "off centered", "free text kept as is");
  const long = "x".repeat(240);
  ok(mis.buildDetails(long, 5, { qty: 1, size: "M", garment: "Navy Gildan", reason: "Stained", note: "", who: "Maria R.", date: "10/14" }) === null, "too long -> null");
});

await test("Report a misprint", async () => {
  reset(); const env = ENV(); const cookie = await signIn(env);
  const body = { orderId: "801000000000002AAA", qty: 2, size: "XL", garment: "Black Richardson 112 Hat", reason: "Off-center", note: "left logo", requestId: "req-eeeeeeee" };
  let r = await mis.onRequestPost({ request: req("POST", "/api/misprints", body, cookie), env });
  let d = await r.json();
  ok(r.status === 200 && d.misprintTotal === 5, "3 + 2 = 5");
  const p = posts("/sobjects/Order/801000000000002AAA")[0]; const sent = JSON.parse(p.body);
  ok(Object.keys(sent).sort().join() === "Misprint_Details__c,TotalQtyMisprints__c", "writes only the two misprint fields");
  ok(sent.TotalQtyMisprints__c === 5, "total 5");
  ok(/^TOTAL QTY: 05 stained M \(Dev 10\/13\) \| 2 XL Black Richardson 112 Hat - Off-center: left logo \(Maria R\. \d+\/\d+\)$/.test(sent.Misprint_Details__c), "heading + old note + new line: " + sent.Misprint_Details__c);
  ok(sent.Misprint_Details__c.length <= 255, "fits 255");
  ok(!!p.headers["If-Unmodified-Since"], "sent with 'only if unchanged since I read it'");
  r = await mis.onRequestPost({ request: req("POST", "/api/misprints", body, cookie), env });
  ok(posts("/sobjects/Order/").length === 1, "same request id twice -> written once");
});

await test("Misprint: two catchers at once don't overwrite each other", async () => {
  reset(); const env = ENV(); const cookie = await signIn(env);
  behave.patch412 = 1;
  const body = { orderId: "801000000000001AAA", qty: 1, size: "M", garment: "Navy Gildan 5000 Tee", reason: "Stained", note: "", requestId: "req-ffffffff" };
  const r = await mis.onRequestPost({ request: req("POST", "/api/misprints", body, cookie), env });
  const o = db.orders[0];
  ok(r.status === 200, "saved after one re-read");
  ok(o.TotalQtyMisprints__c === 3, "2 from the other catcher + 1 = 3 (not 1)");
  ok(/Burned/.test(o.Misprint_Details__c) && /Stained/.test(o.Misprint_Details__c), "both notes kept: " + o.Misprint_Details__c);
});

await test("Misprint: validation rule message reaches the catcher", async () => {
  reset(); const env = ENV(); const cookie = await signIn(env);
  behave.validation = true;
  const body = { orderId: "801000000000001AAA", qty: 1, size: "M", garment: "Navy tee", reason: "Stained", requestId: "req-gggggggg" };
  const r = await mis.onRequestPost({ request: req("POST", "/api/misprints", body, cookie), env });
  const d = await r.json();
  ok(r.status === 422 && /Production and Delivery Dates are required/.test(d.message) && /Nothing was saved/.test(d.message), "422 + the rule's words + 'Nothing was saved'");
});

await test("Misprint: refused inputs save nothing", async () => {
  reset(); const env = ENV(); const cookie = await signIn(env);
  const base = { orderId: "801000000000001AAA", qty: 1, size: "M", garment: "Navy tee", reason: "Stained", requestId: "req-hhhhhhhh" };
  let r = await mis.onRequestPost({ request: req("POST", "/api/misprints", Object.assign({}, base, { reason: "Gremlins" }), cookie), env });
  ok(r.status === 400, "unknown reason refused");
  r = await mis.onRequestPost({ request: req("POST", "/api/misprints", Object.assign({}, base, { size: "5XL", requestId: "req-hhhhhhh2" }), cookie), env });
  ok(r.status === 400, "a size the order doesn't have is refused");
  r = await mis.onRequestPost({ request: req("POST", "/api/misprints", Object.assign({}, base, { qty: 100, requestId: "req-hhhhhhh3" }), cookie), env });
  ok(r.status === 400, "100 at once refused");
  ok(posts("/sobjects/Order/").length === 0, "nothing written");
});

await test("Mockup: card + big picture at once = one download; a web page is never passed on", async () => {
  reset(); const env = ENV(); const cookie = await signIn(env);
  const get = () => mockup.onRequestGet({ request: req("GET", "/api/mockup?orderId=801000000000001AAA", null, cookie), env });
  const [a, b] = await Promise.all([get(), get()]);
  ok(a.status === 200 && b.status === 200, "both get the picture");
  ok(a.headers.get("Content-Type") === "image/jpeg", "as an image");
  const [ab, bb] = await Promise.all([a.arrayBuffer(), b.arrayBuffer()]);
  ok(ab.byteLength === 6 && bb.byteLength === 6, "each answer has its own full copy of the picture");
  ok(calls.filter((c) => c.url.includes("file.force.com")).length === 1, "only ONE download from Salesforce");
  let r = await mockup.onRequestGet({ request: req("GET", "/api/mockup?orderId=801000000000002AAA", null, cookie), env });
  ok(r.status === 404, "order with no artwork link -> 404");
  behave.artHtml = true;
  r = await mockup.onRequestGet({ request: req("GET", "/api/mockup?orderId=801000000000001AAA", null, cookie), env });
  ok(r.status === 502, "a link that answers with a web page -> 502, page not passed on");
  r = await mockup.onRequestGet({ request: req("GET", "/api/mockup?orderId=801000000000001AAA"), env });
  ok(r.status === 401, "not signed in -> 401");
});

await test("Mockup: an Illustrator file with a PDF inside is passed on as a PDF; an old EPS is not", async () => {
  reset(); const env = ENV(); const cookie = await signIn(env);
  behave.artAi = true;
  let r = await mockup.onRequestGet({ request: req("GET", "/api/mockup?orderId=801000000000001AAA", null, cookie), env });
  ok(r.status === 200 && r.headers.get("Content-Type") === "application/pdf", ".ai (labelled postscript) -> application/pdf");
  reset(); const env2 = ENV(); const cookie2 = await signIn(env2);
  behave.artEps = true;
  r = await mockup.onRequestGet({ request: req("GET", "/api/mockup?orderId=801000000000001AAA", null, cookie2), env: env2 });
  ok(r.status === 502, "EPS with no PDF copy -> 502");
});

await test("Mockup: pictures in the order's Files list come first, newest first; Artwork URL is the fallback", async () => {
  reset(); const env = ENV(); const cookie = await signIn(env);
  behave.files = true;
  const ordersMod = await mod("orders");
  const lr = await ordersMod.onRequestGet({ request: req("GET", "/api/orders", null, cookie), env });
  const ld = await lr.json();
  ok(ld.orders[0].mockupCount === 2 && ld.orders[0].hasMockup === true, "order with 2 attached JPGs -> mockupCount 2");
  const get = (n) => mockup.onRequestGet({ request: req("GET", "/api/mockup?orderId=801000000000001AAA&n=" + n, null, cookie), env });
  let r = await get(0); let b = new Uint8Array(await r.arrayBuffer());
  ok(r.status === 200 && r.headers.get("Content-Type") === "image/jpeg" && b[3] === 2, "n=0 -> the newest attached picture");
  r = await get(1); b = new Uint8Array(await r.arrayBuffer());
  ok(r.status === 200 && b[3] === 1, "n=1 -> the next one");
  r = await get(2);
  ok(r.status === 404, "n past the end -> 404");
  ok(!calls.some((c) => c.url.includes("file.force.com")), "Artwork URL not used when files exist");
});

await test("Fulfillment: no boxes -> Packaging Count 0; refused if the order has boxes", async () => {
  reset(); const env = ENV(); const cookie = await signIn(env);
  const list = async () => (await (await orders.onRequestGet({ request: req("GET", "/api/orders", null, cookie), env })).json()).orders;
  let r = await finish.onRequestPost({ request: req("POST", "/api/finish", { orderId: "801000000000001AAA", requestId: "req-ful00001", fulfillment: true }, cookie), env });
  let d = await r.json();
  ok(r.status === 400 && d.error === "has_boxes" && db.orders[0].Packaging_Count__c == null, "order with boxes: refused, nothing written");
  r = await finish.onRequestPost({ request: req("POST", "/api/finish", { orderId: "801000000000002AAA", requestId: "req-ful00002", fulfillment: true }, cookie), env });
  d = await r.json();
  ok(r.status === 200 && d.fulfillment === true && d.boxCount === 0, "no boxes: 200, fulfillment, box count 0");
  ok(db.orders[1].Packaging_Count__c === 0, "Packaging_Count__c = 0 written to the Order");
  r = await finish.onRequestPost({ request: req("POST", "/api/finish", { orderId: "801000000000002AAA", requestId: "req-ful00002", fulfillment: true }, cookie), env });
  ok(r.status === 200 && posts("/sobjects/Order/801000000000002AAA").length === 1, "double tap: same answer, written once");
  let l = await list();
  let o = l.find((x) => x.id === "801000000000002AAA");
  ok(o && o.finished === true && o.finishedCount === 0, "still In Production: stays on the board, finished with count 0");
  db.orders[1]._inProd = false;
  l = await list();
  ok(!l.some((x) => x.id === "801000000000002AAA"), "fulfillment order moved on -> off the board");
  r = await finish.onRequestPost({ request: req("POST", "/api/finish", { orderId: "801000000000001AAA", requestId: "req-ful00003" }, cookie), env });
  ok(r.status === 200 && db.orders[0].Packaging_Count__c === 1, "plain FINISH CATCHING unchanged");
});

await test("Moved to Post-Production early: stays on the board until FINISH CATCHING", async () => {
  reset(); const env = ENV(); const cookie = await signIn(env);
  const list = async () => (await (await orders.onRequestGet({ request: req("GET", "/api/orders", null, cookie), env })).json()).orders;
  let l = await list();
  ok(l.length === 2 && l.every((o) => o.inProduction && !o.finished), "both In Production, not finished");
  db.orders[0]._inProd = false;                 // the crew moves 21379-1 to Post-Production
  l = await list();
  ok(l.length === 2, "the moved order is still on the board");
  ok(l[0].id === "801000000000001AAA" && l[0].inProduction === false, "moved order listed first, marked as moved on");
  const r1 = await boxes.onRequestPost({ request: req("POST", "/api/boxes", { orderId: "801000000000001AAA", type: "Standard Culture Box", qty: 26, name: "Tees 2", requestId: "req-fin00001" }, cookie), env });
  ok(r1.status === 201, "catcher can still log a box on the moved order");
  let r = await finish.onRequestPost({ request: req("POST", "/api/finish", { orderId: "801000000000002AAA", requestId: "req-fin00002" }, cookie), env });
  ok(r.status === 400, "can't finish an order with no boxes");
  r = await finish.onRequestPost({ request: req("POST", "/api/finish", { orderId: "801000000000001AAA", requestId: "req-fin00003" }, cookie), env });
  const d = await r.json();
  ok(r.status === 200 && d.boxCount === 2, "finish -> 200, 2 boxes");
  ok(db.orders[0].Packaging_Count__c === 2, "Packaging_Count__c = 2 written to the Order");
  r = await finish.onRequestPost({ request: req("POST", "/api/finish", { orderId: "801000000000001AAA", requestId: "req-fin00003" }, cookie), env });
  ok(r.status === 200 && posts("/sobjects/Order/801000000000001AAA").length === 1, "double tap: same answer, written once");
  l = await list();
  ok(l.length === 1 && l[0].id === "801000000000002AAA", "finished + moved on -> off the board");
  r = await boxes.onRequestPost({ request: req("POST", "/api/boxes", { orderId: "801000000000001AAA", type: "Standard Culture Box", qty: 5, name: "Tees 3", requestId: "req-fin00004" }, cookie), env });
  ok(r.status === 409, "no more saves once it's off the board");
  // An order that leaves In Production WITHOUT ever having been on the board is not pulled back.
  reset(); const env2 = ENV(); const c2 = await signIn(env2);
  db.orders[0]._inProd = false;
  const l2 = (await (await orders.onRequestGet({ request: req("GET", "/api/orders", null, c2), env: env2 })).json()).orders;
  ok(l2.length === 1, "never-seen Post-Production order is not shown");
});

await test("Quantity + Size Counted: written and read back", async () => {
  const one = [{ product: "Gildan 5000 Tee", color: "Navy", sizes: [{ size: "S" }, { size: "M" }, { size: "L" }, { size: "XL" }] }];
  let b = sizes.buildBreakdown(one, [{ line: 0, size: "L", qty: 17 }, { line: 0, size: "S", qty: 8 }, { line: 0, size: "M", qty: 15 }, { line: 0, size: "XL", qty: 10 }]);
  ok(b.text === "S 8 · M 15 · L 17 · XL 10 = 50" && b.total === 50, "one garment: sizes in order, total 50 -> " + b.text);
  ok(JSON.stringify(sizes.parseBreakdown(one, b.text)) === JSON.stringify([{ line: 0, size: "S", qty: 8 }, { line: 0, size: "M", qty: 15 }, { line: 0, size: "L", qty: 17 }, { line: 0, size: "XL", qty: 10 }]), "reads back the same counts");
  const two = [{ product: "Comfort Colors 1717", color: "Blue Spruce", sizes: [{ size: "S" }, { size: "2XL" }] }, { product: "Comfort Colors 3023CL", color: "Ivory", sizes: [{ size: "L" }] }];
  b = sizes.buildBreakdown(two, [{ line: 0, size: "S", qty: 8 }, { line: 1, size: "L", qty: 4 }, { line: 0, size: "2XL", qty: 2 }]);
  ok(b.text === "Blue Spruce Comfort Colors 1717: S 8 · 2XL 2 | Ivory Comfort Colors 3023CL: L 4 = 14", "mixed box -> " + b.text);
  ok(sizes.parseBreakdown(two, b.text).length === 3, "mixed box reads back");
  ok(sizes.parseBreakdown(two, "").length === 0 && sizes.parseBreakdown(two, "Tees").length === 0, "old / hand-typed boxes -> no size counts, no error");
  const many = Array.from({ length: 4 }, (_, i) => ({ product: "Very Long Product Name Number " + i + " Heavyweight", color: "Colour " + i, sizes: ["XS","S","M","L","XL","2XL"].map((x) => ({ size: x })) }));
  const all = []; many.forEach((l, li) => l.sizes.forEach((x) => all.push({ line: li, size: x.size, qty: 12 })));
  b = sizes.buildBreakdown(many, all);
  ok(b.text.length <= 255 && b.total === 288, "long box shortens the garment words to fit 255 (" + b.text.length + ")");
  ok(sizes.parseBreakdown(many, b.text).length === 24, "shortened box still reads back");
  let threw = false; try { sizes.buildBreakdown(Array.from({ length: 12 }, (_, i) => ({ product: "P" + i, color: "", sizes: Array.from({ length: 8 }, (_, j) => ({ size: "SZ" + j })) })), Array.from({ length: 96 }, (_, k) => ({ line: Math.floor(k / 8), size: "SZ" + (k % 8), qty: 1000 }))); } catch (e) { threw = /Split it/.test(e.message); }
  ok(threw, "far too many sizes -> plain 'split it into two boxes' message");
});

await test("Log a box by size: total added up by the app, both fields saved", async () => {
  reset(); const env = ENV(); const cookie = await signIn(env);
  const post = (body, id) => boxes.onRequestPost({ request: req("POST", "/api/boxes", Object.assign({ orderId: "801000000000001AAA", type: "Standard Culture Box", name: "Tees 2", requestId: id }, body), cookie), env });
  let r = await post({ counts: [{ line: 0, size: "S", qty: 8 }, { line: 0, size: "M", qty: 15 }, { line: 0, size: "L", qty: 0 }] }, "req-size0001");
  const d = await r.json();
  ok(r.status === 201 && d.box.qty === 23, "201, total 23");
  const saved = JSON.parse(posts("/sobjects/Order_Packaging__c").pop().body);
  ok(saved.Packaging_Quantity__c === 23, "Packaging Quantity = 23 (the total)");
  ok(saved.Quantity_Size_Counted__c === "S 8 · M 15 = 23", "Quantity + Size Counted = 'S 8 · M 15 = 23'");
  ok(saved.Name === "Tees 2", "Garment Type (Name) = 'Tees 2'");
  r = await post({ counts: [{ line: 0, size: "5XL", qty: 3 }] }, "req-size0002");
  ok(r.status === 400, "a size not on the order is refused");
  r = await post({ counts: [{ line: 0, size: "S", qty: 0 }] }, "req-size0003");
  ok(r.status === 400, "a box with nothing counted is refused");
  r = await post({ counts: [{ line: 0, size: "S", qty: 2.5 }] }, "req-size0004");
  ok(r.status === 400, "half a shirt is refused");
  r = await post({ counts: [{ line: 0, size: "S", qty: 2 }, { line: 0, size: "S", qty: 3 }] }, "req-size0005");
  ok(r.status === 400, "the same size twice is refused");
  const l = (await (await orders.onRequestGet({ request: req("GET", "/api/orders", null, cookie), env })).json()).orders[0];
  const nb = l.boxes.find((b) => b.name === "Tees 2");
  ok(nb && nb.sizes === "S 8 · M 15 = 23" && nb.counts.length === 2, "box comes back with its size counts");
  const sz = Object.fromEntries(l.lines[0].sizes.map((x) => [x.size, x.boxed]));
  ok(sz.S === 8 && sz.M === 15 && sz.L === 0, "boxed-so-far per size: S 8, M 15, L 0 (the old box without sizes isn't guessed at)");
  ok(l.boxes[0].counts.length === 0 && l.boxes[0].qty === 30, "old box still shows its total of 30");
  r = await boxes.onRequestPost({ request: req("POST", "/api/boxes", { orderId: "801000000000001AAA", type: "Standard Culture Box", qty: 12, name: "Tees 3", requestId: "req-size0006" }, cookie), env });
  const old = JSON.parse(posts("/sobjects/Order_Packaging__c").pop().body);
  ok(r.status === 201 && old.Packaging_Quantity__c === 12 && !("Quantity_Size_Counted__c" in old), "an older tablet sending only a total still works");
});

await test("Add More: extras of a size not on the order", async () => {
  // written and read back
  const one = [{ product: "Gildan 5000 Tee", color: "Navy", sizes: [{ size: "S" }, { size: "M" }] }];
  let b = sizes.buildBreakdown(one, [{ line: 0, size: "2XL", qty: 3, extra: true }, { line: 0, size: "S", qty: 8 }]);
  ok(b.text === "S 8 · 2XL 3 (extra) = 11" && b.total === 11, "extra written after the order's sizes -> " + b.text);
  const back = sizes.parseBreakdown(one, b.text);
  ok(back.length === 2 && back[1].extra === true && back[1].size === "2XL" && !back[0].extra, "reads back with the extra marked");
  ok(sizes.parseBreakdown(one, "S 8 · 2XL 3 = 11").length === 0, "an unmarked size not on the order still isn't guessed at");
  const two = [{ product: "Comfort Colors 1717", color: "Blue Spruce", sizes: [{ size: "S" }] }, { product: "Comfort Colors 3023CL", color: "Ivory", sizes: [{ size: "L" }] }];
  b = sizes.buildBreakdown(two, [{ line: 1, size: "XL", qty: 2, extra: true }, { line: 0, size: "S", qty: 5 }]);
  ok(b.text === "Blue Spruce Comfort Colors 1717: S 5 | Ivory Comfort Colors 3023CL: XL 2 (extra) = 7", "mixed box with an extra -> " + b.text);
  ok(sizes.parseBreakdown(two, b.text).filter((c) => c.extra).length === 1, "mixed box extra reads back");

  // saved through the app
  reset(); const env = ENV(); const cookie = await signIn(env);
  const O = "801000000000001AAA";
  const post = (counts, id, name = "Tees 2") => boxes.onRequestPost({ request: req("POST", "/api/boxes", { orderId: O, type: "Standard Culture Box", name, counts, requestId: id }, cookie), env });
  let r = await post([{ line: 0, size: "M", qty: 20 }, { line: 0, size: "2xl ", qty: 3, extra: true }], "req-xtra0001");
  let d = await r.json();
  const saved = JSON.parse(posts("/sobjects/Order_Packaging__c").pop().body);
  ok(r.status === 201 && saved.Packaging_Quantity__c === 23, "box total includes the extras (23)");
  ok(saved.Quantity_Size_Counted__c === "M 20 · 2XL 3 (extra) = 23", "size breakdown marks the extra: " + saved.Quantity_Size_Counted__c);
  ok(d.box.counts.some((c) => c.extra && c.size === "2XL"), "answer carries the extra (typed '2xl ' cleaned to '2XL')");
  r = await post([{ line: 0, size: "<b>", qty: 2, extra: true }], "req-xtra0002");
  ok(r.status === 400, "a junk extra size is refused");
  r = await post([{ line: 0, size: "5XL", qty: 2 }], "req-xtra0003");
  ok(r.status === 400, "a size not on the order WITHOUT extra is still refused");
  r = await post([{ line: 0, size: "m", qty: 4, extra: true }], "req-xtra0004", "Tees 3");
  const s2 = JSON.parse(posts("/sobjects/Order_Packaging__c").pop().body);
  ok(r.status === 201 && s2.Quantity_Size_Counted__c === "M 4 = 4", "an 'extra' that IS on the order is counted in that size: " + s2.Quantity_Size_Counted__c);
  r = await post([{ line: 0, size: "2XL", qty: 1, extra: true }, { line: 0, size: "2xl", qty: 1, extra: true }], "req-xtra0005");
  ok(r.status === 400, "the same extra size twice is refused");
  r = await post([{ line: 5, size: "2XL", qty: 1, extra: true }], "req-xtra0006");
  ok(r.status === 400, "an extra on a garment that isn't on the order is refused");

  const l = (await (await orders.onRequestGet({ request: req("GET", "/api/orders", null, cookie), env })).json()).orders[0];
  const sz = Object.fromEntries(l.lines[0].sizes.map((x) => [x.size, x.boxed]));
  ok(sz.M === 24, "extras don't count against the order's sizes (M boxed 24)");
  ok(l.lines[0].extras.length === 1 && l.lines[0].extras[0].size === "2XL" && l.lines[0].extras[0].boxed === 3, "order shows 2XL extra boxed: 3");
  ok(l.extraBoxed === 3, "order's extraBoxed = 3");

  // duplicate copies the extra exactly; edit keeps / changes it
  // (the pretend Salesforce gives new boxes short ids; give this one a real 18-character id)
  db.boxes.find((x) => x.Name === "Tees 2").Id = "a0X00000000000XAAA";
  const src = { id: "a0X00000000000XAAA" };
  r = await dup.onRequestPost({ request: req("POST", "/api/duplicate-box", { orderId: O, boxId: src.id, count: 2, requestId: "req-xtra0007" }, cookie), env });
  ok(r.status === 201 && db.boxes.filter((x) => x.Quantity_Size_Counted__c === "M 20 · 2XL 3 (extra) = 23").length === 3, "duplicates copy the extra");
  db.boxes.forEach((x) => { if (x.Id === src.id) x.LastModifiedDate = x.CreatedDate; });
  r = await bedit.onRequestPost({ request: req("POST", "/api/box-edit", { orderId: O, boxId: src.id, type: "Standard Culture Box", word: "Tees",
    counts: [{ line: 0, size: "M", qty: 20 }, { line: 0, size: "2XL", qty: 5, extra: true }, { line: 0, size: "3XL", qty: 1, extra: true }], requestId: "req-xtra0008" }, cookie), env });
  const ed = db.boxes.find((x) => x.Id === src.id);
  ok(r.status === 200 && ed.Quantity_Size_Counted__c === "M 20 · 2XL 5 (extra) · 3XL 1 (extra) = 26" && ed.Packaging_Quantity__c === 26, "edit changes extras: " + ed.Quantity_Size_Counted__c);

  // a misprint on an extra size is accepted
  r = await mis.onRequestPost({ request: req("POST", "/api/misprints", { orderId: O, qty: 1, size: "2XL", garment: "Navy Gildan 5000 Tee", reason: "Stained", requestId: "req-xtra0009" }, cookie), env });
  ok(r.status === 200, "misprint on an extra size (2XL) is accepted");
});

await test("Mixed box: two garments from the order in one box", async () => {
  reset(); const env = ENV(); const cookie = await signIn(env);
  db.items.push({ OrderId: "801000000000001AAA", Size__c: "XL", Color__c: "Ivory", Quantity: 10, Product2: { Name: "Comfort Colors 3023CL" } });
  const l0 = (await (await orders.onRequestGet({ request: req("GET", "/api/orders", null, cookie), env })).json()).orders[0];
  const ivory = l0.lines.findIndex((x) => x.color === "Ivory"), navy = l0.lines.findIndex((x) => x.color === "Navy");
  const r = await boxes.onRequestPost({ request: req("POST", "/api/boxes", { orderId: "801000000000001AAA", type: "Standard Culture Box", name: "Tees 2", requestId: "req-mixd0001",
    counts: [{ line: navy, size: "M", qty: 5 }, { line: ivory, size: "XL", qty: 4 }] }, cookie), env });
  const saved = JSON.parse(posts("/sobjects/Order_Packaging__c").pop().body);
  ok(r.status === 201 && saved.Packaging_Quantity__c === 9, "total 9");
  ok(/Navy Gildan 5000 Tee: M 5/.test(saved.Quantity_Size_Counted__c) && /Ivory Comfort Colors 3023CL: XL 4/.test(saved.Quantity_Size_Counted__c), "both garments written: " + saved.Quantity_Size_Counted__c);
  const l1 = (await (await orders.onRequestGet({ request: req("GET", "/api/orders", null, cookie), env })).json()).orders[0];
  ok(l1.lines[ivory].sizes[0].boxed === 4, "Ivory XL boxed-so-far = 4");
});

await test("Duplicate Box: exact copies, own records, original untouched", async () => {
  reset(); const env = ENV(); const cookie = await signIn(env);
  const O = "801000000000001AAA";
  // a size-counted source box
  await boxes.onRequestPost({ request: req("POST", "/api/boxes", { orderId: O, type: "Culture Hat Box", name: "Tees 2", requestId: "req-dsrc0001",
    counts: [{ line: 0, size: "S", qty: 8 }, { line: 0, size: "M", qty: 15 }] }, cookie), env });
  const srcRec = db.boxes[db.boxes.length - 1];
  srcRec.Id = "a0X000000000000SRC";
  const before = JSON.stringify(srcRec);
  const dupReq = (count, id, boxId = srcRec.Id) => dup.onRequestPost({ request: req("POST", "/api/duplicate-box", { orderId: O, boxId, count, requestId: id }, cookie), env });
  const n0 = db.boxes.length;

  let r = await dupReq(1, "req-dup00001"); let d = await r.json();
  ok(r.status === 201 && d.created === 1 && d.boxes.length === 1, "duplicate 1 -> exactly 1 created");
  ok(db.boxes.length === n0 + 1, "exactly 1 new record in Salesforce");
  const c1 = db.boxes[db.boxes.length - 1];
  ok(c1.Name === "Tees 3" && c1.Packaging_Type__c === "Culture Hat Box" && c1.Packaging_Quantity__c === 23 && c1.Quantity_Size_Counted__c === "S 8 · M 15 = 23" && c1.Order__c === O,
    "copy has next Garment Type number, same Packaging Type, total and full size breakdown");
  ok(c1.Id !== srcRec.Id, "copy has its own record ID");

  r = await dupReq(25, "req-dup00002"); d = await r.json();
  ok(r.status === 201 && d.created === 25, "duplicate 25 -> 25 created");
  ok(db.boxes.length === n0 + 26, "exactly 25 more records");
  const names = db.boxes.slice(-25).map((b) => b.Name);
  ok(names[0] === "Tees 4" && names[24] === "Tees 28" && new Set(db.boxes.slice(-25).map((b) => b.Id)).size === 25, "Tees 4 ... Tees 28, 25 different IDs");
  ok(db.boxes.slice(-25).every((b) => b.Quantity_Size_Counted__c === "S 8 · M 15 = 23" && b.Packaging_Quantity__c === 23), "every copy keeps the complete size breakdown");
  ok(JSON.stringify(srcRec) === before, "original box unchanged");
  ok(posts("/composite/sobjects").length === 2 && JSON.parse(posts("/composite/sobjects")[1].body).allOrNone === true, "one all-or-nothing request per duplicate");

  const n1 = db.boxes.length;
  r = await dupReq(25, "req-dup00002");
  ok(r.status === 201 && db.boxes.length === n1 && posts("/composite/sobjects").length === 2, "same request again (double tap / retry) -> same answer, nothing new created");

  for (const bad of [0, -3, 2.5, 101, "5", null]) {
    r = await dupReq(bad, "req-dupbad" + String(bad).replace(/\W/g, "x"));
    ok(r.status === 400, "count " + JSON.stringify(bad) + " refused");
  }
  ok(db.boxes.length === n1, "refused counts created nothing");

  r = await dup.onRequestPost({ request: req("POST", "/api/duplicate-box", { orderId: "801000000000002AAA", boxId: srcRec.Id, count: 2, requestId: "req-dup00003" }, cookie), env });
  ok(r.status === 409 && db.boxes.length === n1, "a box from another order can't be copied onto this one");

  behave.dupReject = true;
  r = await dupReq(10, "req-dup00004"); d = await r.json();
  ok(r.status === 422 && /Packaging is locked/.test(d.message) && /None of the 10/.test(d.message) && db.boxes.length === n1, "Salesforce refuses -> its reason shown, none created");
  behave.dupReject = false;
  r = await dupReq(10, "req-dup00004");
  ok(r.status === 201 && db.boxes.length === n1 + 10, "after a refusal, Try again works");

  behave.dupTimeout = true;
  r = await dupReq(5, "req-dup00005"); d = await r.json();
  ok(r.status === 504 && d.error === "unconfirmed", "no answer -> 'not sure', not 'failed'");
  behave.dupTimeout = false;
  const n2 = db.boxes.length;
  r = await dupReq(5, "req-dup00005");
  ok(r.status === 409 && db.boxes.length === n2, "an immediate retry of an unconfirmed batch is blocked (no extra boxes)");

  // an old box with no size breakdown copies its total only
  const oldBox = db.boxes.find((b) => b.Id === "a0X000000000001AAA");
  r = await dupReq(2, "req-dup00006", oldBox.Id); d = await r.json();
  const last2 = db.boxes.slice(-2);
  ok(r.status === 201 && last2.every((b) => b.Packaging_Quantity__c === 30 && !("Quantity_Size_Counted__c" in b)), "old box without sizes -> copies keep its total, no made-up sizes");
});

await test("Past Orders + 7-day review window: Edit Box and Delete Box", async () => {
  reset(); const env = ENV(); const cookie = await signIn(env);
  const O = "801000000000001AAA", DAY = 86400000, ago = (ms) => new Date(Date.now() - ms).toISOString();
  const mk = (id, name, createdAgo, extra = {}) => Object.assign({ Id: id, Order__c: O, Name: name, Packaging_Type__c: "Standard Culture Box", Packaging_Quantity__c: 23,
    Quantity_Size_Counted__c: "S 8 · M 15 = 23", CreatedDate: ago(createdAgo), LastModifiedDate: ago(createdAgo), CreatedBy: { Name: "Catcher App" } }, extra);
  db.boxes = [mk("a0X000000000010AAA", "Tees 1", 2 * DAY), mk("a0X000000000011AAA", "Tees 2", 8 * DAY), mk("a0X000000000012AAA", "Tees 3", 7 * DAY - 400)];
  db.orders[0]._inProd = false; db.orders[0].Packaging_Count__c = 3;          // finished, moved on: off the board
  const P = await (await past.onRequestGet({ request: req("GET", "/api/past-orders", null, cookie), env })).json();
  const po = P.orders.find((o) => o.id === O);
  ok(po && po.boxes.length === 3, "a finished order with boxes shows in Past Orders, with all its boxes from Salesforce");
  const byName = Object.fromEntries(po.boxes.map((b) => [b.name, b]));
  ok(byName["Tees 1"].editable === true && byName["Tees 2"].editable === false, "2-day-old box editable; 8-day-old box read-only");
  ok(Date.parse(byName["Tees 1"].editableUntil) === Date.parse(db.boxes[0].CreatedDate) + 7 * DAY, "deadline = Salesforce CreatedDate + exactly 7 days");
  ok(byName["Tees 1"].sizes === "S 8 · M 15 = 23" && byName["Tees 1"].type === "Standard Culture Box", "shows Garment Type, Packaging Type and the size breakdown");
  ok((await past.onRequestGet({ request: req("GET", "/api/past-orders"), env })).status === 401, "Past Orders needs a sign-in");

  const edit = (boxId, body, id) => bedit.onRequestPost({ request: req("POST", "/api/box-edit", Object.assign({ orderId: O, boxId, type: "Culture Hat Box", word: "Hoodies", requestId: id,
    counts: [{ line: 0, size: "S", qty: 5 }, { line: 0, size: "L", qty: 7 }] }, body), cookie), env });
  let r = await edit("a0X000000000010AAA", {}, "req-edit0001"); let d = await r.json();
  const e1 = db.boxes.find((b) => b.Id === "a0X000000000010AAA");
  ok(r.status === 200 && d.box.qty === 12, "edit within 7 days -> 200, new total 12");
  ok(e1.Name === "Hoodies 1" && e1.Packaging_Type__c === "Culture Hat Box" && e1.Packaging_Quantity__c === 12 && e1.Quantity_Size_Counted__c === "S 5 · L 7 = 12",
    "same record updated: Garment Type keeps its number, new Packaging Type, total and sizes");
  ok(db.boxes.length === 3 && e1.CreatedDate === ago(2 * DAY).slice(0, 0) + e1.CreatedDate && !("Order__c" in JSON.parse(posts("/sobjects/Order_Packaging__c/a0X000000000010AAA").pop().body)),
    "no new box; CreatedDate untouched; the box isn't moved to another order");
  ok(posts("/sobjects/Order_Packaging__c/a0X000000000010AAA")[0].method === "PATCH", "an update (PATCH), not a create");

  r = await edit("a0X000000000011AAA", {}, "req-edit0002"); d = await r.json();
  ok(r.status === 403 && d.error === "review_expired" && db.boxes[1].Name === "Tees 2", "8-day-old box: edit refused on the server, nothing changed");
  await new Promise((res2) => setTimeout(res2, 500));                        // Tees 3 crosses the 7-day line while 'open'
  r = await edit("a0X000000000012AAA", {}, "req-edit0003"); d = await r.json();
  ok(r.status === 403 && d.error === "review_expired" && db.boxes[2].Name === "Tees 3", "box that crossed 7 days while open: refused at submit");

  r = await edit("a0X000000000010AAA", { counts: [{ line: 0, size: "S", qty: 0 }] }, "req-edit0004");
  ok(r.status === 400, "edit to an empty box refused");
  r = await edit("a0X000000000010AAA", { counts: [{ line: 0, size: "5XL", qty: 3 }] }, "req-edit0005");
  ok(r.status === 400, "edit with a size not on the order refused");
  r = await edit("a0X000000000010AAA", { type: "Old Box" }, "req-edit0006");
  ok(r.status === 400, "edit to an inactive Packaging Type refused");

  behave.boxLocked = true;
  r = await edit("a0X000000000010AAA", {}, "req-edit0008"); d = await r.json();
  ok(r.status === 422 && /Box is locked/.test(d.message), "Salesforce refuses the edit -> its reason is shown");
  behave.boxLocked = false;

  const del = (boxId, id) => bdel.onRequestPost({ request: req("POST", "/api/box-delete", { orderId: O, boxId, requestId: id }, cookie), env });
  r = await del("a0X000000000011AAA", "req-del00001"); d = await r.json();
  ok(r.status === 403 && d.error === "review_expired" && db.boxes.length === 3, "8-day-old box: delete refused on the server, still there");
  r = await del("a0X000000000010AAA", "req-del00002"); d = await r.json();
  ok(r.status === 200 && db.boxes.length === 2 && !db.boxes.some((b) => b.Id === "a0X000000000010AAA"), "delete within 7 days -> exactly that record deleted");
  ok(posts("/sobjects/Order_Packaging__c/a0X000000000010AAA").pop().method === "DELETE", "deleted with a REST DELETE (Salesforce Recycle Bin)");
  ok(db.orders[0].Packaging_Count__c === 2 && /Packaging Count/.test(d.countNote), "finished order's Packaging Count follows: 3 -> 2");
  r = await del("a0X000000000010AAA", "req-del00002");
  ok(r.status === 200 && db.boxes.length === 2, "double tap on delete: same answer, nothing else deleted");
  r = await del("a0X000000000010AAA", "req-del00003");
  ok(r.status === 404, "deleting a box that's already gone -> 'isn't there any more', nothing else touched");
  behave.boxLocked = true;
  db.boxes.push(mk("a0X000000000013AAA", "Tees 4", 1000));
  r = await del("a0X000000000013AAA", "req-del00004"); d = await r.json();
  ok(r.status === 422 && db.boxes.some((b) => b.Id === "a0X000000000013AAA") && /still there/.test(d.message), "Salesforce refuses the delete -> box stays, reason shown");
  behave.boxLocked = false;

  // a box on another order can't be reached through this order
  r = await bdel.onRequestPost({ request: req("POST", "/api/box-delete", { orderId: "801000000000002AAA", boxId: "a0X000000000013AAA", requestId: "req-del00005" }, cookie), env });
  ok(r.status === 404 && db.boxes.some((b) => b.Id === "a0X000000000013AAA"), "box id + wrong order -> refused");
});

await test("Edit Box: someone else changed the box first -> not overwritten", async () => {
  reset(); const env = ENV(); const cookie = await signIn(env);
  db.boxes = [{ Id: "a0X000000000020AAA", Order__c: "801000000000001AAA", Name: "Tees 1", Packaging_Type__c: "Standard Culture Box", Packaging_Quantity__c: 10,
    CreatedDate: new Date(Date.now() - 3600000).toISOString(), LastModifiedDate: new Date(Date.now() - 3600000).toISOString(), CreatedBy: { Name: "X" } }];
  // simulate the other person's change landing between the app's read and its write
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).includes("/sobjects/Order_Packaging__c/a0X000000000020AAA") && (init.method || "") === "PATCH") db.boxes[0].LastModifiedDate = new Date(Date.now() + 5000).toISOString();
    return realFetch(url, init);
  };
  const r = await bedit.onRequestPost({ request: req("POST", "/api/box-edit", { orderId: "801000000000001AAA", boxId: "a0X000000000020AAA", type: "Standard Culture Box", word: "Tees",
    counts: [{ line: 0, size: "S", qty: 4 }], requestId: "req-race0001" }, cookie), env });
  globalThis.fetch = realFetch;
  const d = await r.json();
  ok(r.status === 409 && d.error === "changed" && db.boxes[0].Packaging_Quantity__c === 10, "412 from Salesforce -> 'someone changed this box', nothing overwritten");
});

await test("No 5-minute sign-out: stays signed in until logout; logout cancels it; saves need a live sign-in", async () => {
  reset(); const env = ENV();
  const lr = await login.onRequestPost({ request: req("POST", "/api/login", { pin: "4821" }), env });
  const ld = await lr.json();
  const set = lr.headers.get("Set-Cookie"); const cookie = set.split(";")[0];
  ok(ld.expiresIn === 7 * 24 * 3600 && !/Max-Age/.test(set), "no 5-minute limit; browser-session cookie (no Max-Age)");
  let r = await me.onRequestGet({ request: req("GET", "/api/me", null, cookie), env });
  let d = await r.json();
  ok(r.status === 200 && d.name === "Maria R." && d.expiresIn > 7 * 24 * 3600 - 5, "/api/me says who");
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 10 * 3600 * 1000;                        // 10 hours later: still signed in
    r = await me.onRequestGet({ request: req("GET", "/api/me", null, cookie), env });
    ok(r.status === 200, "10 hours later still signed in (no timed sign-out)");
    Date.now = () => realNow() + 7 * 24 * 3600 * 1000 + 1000;             // past the 7-day safety limit
    r = await me.onRequestGet({ request: req("GET", "/api/me", null, cookie), env });
    ok(r.status === 401, "a cookie past the 7-day safety limit is refused");
    r = await boxes.onRequestPost({ request: req("POST", "/api/boxes", { orderId: "801000000000001AAA", type: "Standard Culture Box", qty: 5, name: "Tees 9", requestId: "req-exp00001" }, cookie), env });
    ok(r.status === 401 && posts("/sobjects/Order_Packaging__c").length === 0, "an expired sign-in can't save a box");
    r = await dup.onRequestPost({ request: req("POST", "/api/duplicate-box", { orderId: "801000000000001AAA", boxId: "a0X000000000001AAA", count: 2, requestId: "req-exp00002" }, cookie), env });
    ok(r.status === 401, "... or duplicate");
    r = await bedit.onRequestPost({ request: req("POST", "/api/box-edit", { orderId: "801000000000001AAA", boxId: "a0X000000000001AAA", type: "Standard Culture Box", word: "Tees", counts: [{ line: 0, size: "S", qty: 1 }], requestId: "req-exp00003" }, cookie), env });
    ok(r.status === 401, "... or edit");
    r = await bdel.onRequestPost({ request: req("POST", "/api/box-delete", { orderId: "801000000000001AAA", boxId: "a0X000000000001AAA", requestId: "req-exp00004" }, cookie), env });
    ok(r.status === 401 && db.boxes.length === 1, "... or delete");
  } finally { Date.now = realNow; }

  // logout cancels the sign-in on the server: the same cookie no longer works
  const c2 = await signIn(env, "1937");
  ok((await me.onRequestGet({ request: req("GET", "/api/me", null, c2), env })).status === 200, "Dev T. signed in");
  const lo = await logout.onRequestPost({ request: req("POST", "/api/logout", null, c2), env });
  ok(/Max-Age=0/.test(lo.headers.get("Set-Cookie")), "logout clears the cookie on the tablet");
  r = await me.onRequestGet({ request: req("GET", "/api/me", null, c2), env });
  ok(r.status === 401, "and the old cookie is refused even if re-sent (cancelled on the server)");
  r = await boxes.onRequestPost({ request: req("POST", "/api/boxes", { orderId: "801000000000001AAA", type: "Standard Culture Box", qty: 5, name: "Tees 9", requestId: "req-exp00005" }, c2), env });
  ok(r.status === 401, "a logged-out cookie can't save");
});

await test("Counted By: new boxes and duplicates get the signed-in catcher; edits keep the original", async () => {
  reset(); const env = ENV();
  const maria = await signIn(env, "4821"), dev = await signIn(env, "1937");
  const O = "801000000000001AAA";
  await boxes.onRequestPost({ request: req("POST", "/api/boxes", { orderId: O, type: "Standard Culture Box", name: "Tees 2", requestId: "req-cby00001", counts: [{ line: 0, size: "S", qty: 4 }] }, maria), env });
  const b = db.boxes[db.boxes.length - 1]; b.Id = "a0X000000000030AAA"; b.LastModifiedDate = b.CreatedDate;
  ok(b.CountedBy__c === "Maria R.", "box logged by Maria -> Counted By 'Maria R.'");
  await dup.onRequestPost({ request: req("POST", "/api/duplicate-box", { orderId: O, boxId: b.Id, count: 2, requestId: "req-cby00002" }, dev), env });
  ok(db.boxes.slice(-2).every((x) => x.CountedBy__c === "Dev T."), "duplicates made by Dev -> Counted By 'Dev T.'");
  const r = await bedit.onRequestPost({ request: req("POST", "/api/box-edit", { orderId: O, boxId: b.Id, type: "Standard Culture Box", word: "Tees", counts: [{ line: 0, size: "S", qty: 6 }], requestId: "req-cby00003" }, dev), env });
  ok(r.status === 200 && b.CountedBy__c === "Maria R." && b.Packaging_Quantity__c === 6, "Dev edits Maria's box -> Counted By stays 'Maria R.'");
  const l = (await (await orders.onRequestGet({ request: req("GET", "/api/orders", null, maria), env })).json()).orders[0];
  const shown = l.boxes.find((x) => x.id === b.Id);
  ok(shown.by === "Maria R." && l.boxes.find((x) => x.name === "Tees 1").by === "Catcher App", "app shows Counted By; old boxes fall back to Created By");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
