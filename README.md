# Dryer Catch — Culture Apparel

A tablet app for the catchers at the end of the screen-print dryers. It is a separate
project from the production dashboard: its own GitHub repository, its own Cloudflare
Pages project, its own Salesforce connection and its own PIN list.

## What it does

- Lists **screen-print orders that are In Production**, using the same rules as
  Production's **Print Shop** Order list view (In Production column):
  - Production Status (`Order_Substatus__c`) = In Production. The stored value is `Production`.
  - Printer (`Printer__r.Name`) = "Culture Apparel" or "Culture Apparel Press 2".
  - Print Date (`Print_Date__c`) later than 10 days ago.
- **Log Boxes:** one `Order_Packaging__c` record per box (Name such as "Tees 2", Order,
  Packaging Type, garments in the box). This is the same record the "Enter Packaging"
  flow creates. Box count = number of records.
- **Report Misprint:** on the Order it adds to `TotalQtyMisprints__c` and adds one line to
  `Misprint_Details__c` under the "TOTAL QTY: NN" heading. The heading keeps the
  Total Quantity Misprints formula and the misprint-rate reports correct. Changing
  Misprint Details runs the "Printshop Misprint Process" flow, which notifies the print shop.
- Tap the mockup to open it full screen: pinch, double-tap or +/– to zoom, drag to move.
- – / + in the header makes the whole screen smaller or bigger (85%–175%). At larger
  sizes the screen switches to one column.

## Safety rules built in

- Nothing shows as saved until Salesforce confirms it.
- Every save carries a one-time ID, so a double tap or a retry can't create two boxes.
- A save that times out is shown as **"not sure it saved"**, and the order is reloaded.
  It is never shown as saved, and never as failed.
- A misprint is written "only if nobody changed the order since it was read". If someone
  did, the app re-reads and adds on top, so two catchers can't overwrite each other.
- Every save first re-checks that the order is still In Production for screen print.
- Salesforce's own error message (for example a validation rule) is shown to the catcher.
- A failed Salesforce read is shown as an error, never as an empty list.
- The browser never sees Salesforce credentials or stored file links. Mockups
  (`Order.Artwork_URL__c`) are fetched by the server, and only for orders the app is
  allowed to show. A PDF artwork opens in the tablet's own viewer when tapped.

## Files

```
index.html, app.css, app.js     the tablet screen (no build step)
_headers                        security headers
functions/api/                  the server (Cloudflare Pages Functions)
  _sf.js                        Salesforce connection (one org, client credentials)
  _session.js                   PIN sign-in, signed cookie, duplicate-save guard
  _orders.js                    which orders are shown, how one is read
  _mockup.js                    mockup lookup and fetch
  login.js logout.js me.js      sign-in
  orders.js                     GET  the order list
  box-types.js                  GET  active Packaging Type values
  boxes.js                      POST log one box
  misprints.js                  POST record a misprint
  mockup.js                     GET  one order's mockup picture
tools/test.mjs                  offline tests against a pretend Salesforce
```

## Cloudflare Pages settings

Build command: *(none)*. Build output directory: `/`.

**Secrets** (Settings → Variables and Secrets → type *Secret*):

| Name | Value |
|---|---|
| `SF_LOGIN_URL` | `https://cultureapparel.my.salesforce.com` |
| `SF_CLIENT_ID` | the connected app's Consumer Key |
| `SF_CLIENT_SECRET` | the connected app's Consumer Secret |
| `SESSION_SECRET` | 40+ random characters |
| `CATCHER_PINS` | `{"Maria R.":"4821","Dev T.":"1937"}`: each catcher's name and 4-digit PIN |

**Optional:** `SESSION_HOURS` (default 12), `PRINTER_NAMES` (comma list overriding the two
printers), `SF_API_VERSION` (default `v61.0`).

**KV binding** (Settings → Bindings → KV namespace): variable name `CATCHER_KV`. This is
what slows down PIN guessing and stops duplicate saves. Without it the app still works,
but without those two protections.

## Salesforce (Production) setup

1. **Integration user.** A user only this app logs in as, given only the access below.
2. **Connected app** with OAuth "Client Credentials Flow" enabled, run as that user.
   Copy its Consumer Key and Consumer Secret into Cloudflare.
3. **Access the integration user needs:**
   - Order: Read, and Edit on `TotalQtyMisprints__c` and `Misprint_Details__c`.
     Read on the fields the list uses: `GOA_Order_Number__c`, `Order_Substatus__c`,
     `Printer__c`, `Print_Date__c`, `Specifications_for_Printing__c`, `Artwork_URL__c`.
   - Order Product (OrderItem): Read on `Size__c`, `Color__c`, Quantity, and the Product name.
   - Order Packaging (`Order_Packaging__c`): Read + Create, with Edit on Name,
     `Order__c`, `Packaging_Type__c` and `Packaging_Quantity__c`.
   - Design (`Design__c`): Read on `Opportunity__c` and `Mockup_URL__c` (fallback only).
   - Mockups come from `Order.Artwork_URL__c`, a public file link, so no file access is needed.

## Tests

```
node tools/test.mjs
```

The tests run against a pretend Salesforce, with no network. They cover sign-in, the
PIN brake, the order filter, box and misprint saves, duplicate taps, timeouts, two
catchers at once, and validation-rule messages.
