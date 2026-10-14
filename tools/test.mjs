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
const mockup = await mod("mockup");

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
    boxes: [{ Id: "a0X1", Order__c: "801000000000001AAA", Name: "Tees 1", Packaging_Type__c: "Standard Culture Box", Packaging_Quantity__c: 30, CreatedDate: "2026-10-14T15:00:00.000+0000", CreatedBy: { Name: "Catcher App" } }],
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
    return new Response(new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]), { status: 200, headers: { "Content-Type": "image/jpeg" } });
  }
  if (url.endsWith("/services/oauth2/token")) return res(200, { access_token: "TOKEN", instance_url: "https://ca.my.salesforce.com" });
  const u = new URL(url);
  if (u.pathname.endsWith("/query")) {
    const q = u.searchParams.get("q");
    if (/FROM Order WHERE/.test(q)) {
      if (behave.queryFail) return res(400, [{ errorCode: "INVALID_FIELD", message: "No such column" }]);
      const idm = q.match(/AND Id = '([^']+)'/);
      let recs = db.orders.filter((o) => o._inProd);
      if (idm) recs = recs.filter((o) => o.Id === idm[1]);
      return res(200, { done: true, records: recs.map((o) => { const { _inProd, ...r } = o; return r; }) });
    }
    if (/FROM OrderItem/.test(q)) return res(200, { done: true, records: db.items.filter((i) => q.includes(i.OrderId)) });
    if (/FROM Order_Packaging__c/.test(q)) return res(200, { done: true, records: db.boxes.filter((b) => q.includes(b.Order__c)) });
    if (/FROM Design__c/.test(q)) return res(200, { done: true, records: db.designs.filter((d) => q.includes(d.Opportunity__c)) });
    return res(200, { done: true, records: [] });
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
  r = await me.onRequestGet({ request: req("GET", "/api/me", null, cookie.replace(/.$/, "x")), env });
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
  ok(Object.keys(sent).length === 4, "and nothing else");
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
