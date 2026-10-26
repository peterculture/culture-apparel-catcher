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
- **Log Boxes:** one `Order_Packaging__c` record per box, counted **by size**. The catcher
  taps a size and types its count, for any garment on the order; one box can hold several garments.
  - **Garment Type** (`Name`, relabelled 10-15): the shop word plus the box number, e.g. "Tees 2".
  - **Packaging Type** (`Packaging_Type__c`): the box used. Unchanged.
  - **Packaging Quantity** (`Packaging_Quantity__c`): the box's total, added up by the app from the
    size counts so the two can't disagree. It stays a number, so reports, the dashboard and the
    Enter Packaging flow keep working.
  - **Quantity + Size Counted** (`Quantity_Size_Counted__c`, Text 255, added 10-15): the breakdown, e.g.
    `S 8 · M 15 · L 17 · XL 10 = 50`, or for an order with several garments
    `Blue Spruce Comfort Colors 1717: S 8 · M 15 | Ivory Comfort Colors 3023CL: L 4 = 27`.
    Boxes logged before 10-15 (and by the flow or the dashboard) leave it blank and show just their total.
  - Sizes come from the order's own lines (`OrderItem.Size__c` is free text, so there's no fixed size list).
  - Box count = number of records.
- **Add More / extras (10-26):** the garment supplier sometimes sends extras that get printed and boxed
  for the customer. Every box form has a **+ ADD MORE** tile (one per garment on the order). It opens a
  size picker (YXS … 5XL, OSFA, or type another size up to 10 characters, e.g. 6XL); the picked size gets
  its own dashed EXTRA tile, counted on the number pad like any size. Extras of a size that IS on the
  order aren't added this way -- they're just counted in that size, past what's left.
  - Saved in the same box record: `Quantity_Size_Counted__c` marks them, e.g. `M 20 · 2XL 3 (extra) = 23`,
    and `Packaging_Quantity__c` includes them (they're really in the box). No new Salesforce field.
  - The app keeps extras apart from the order's own count: card "20 of 56 boxed + 3 extra", the order's
    size panel shows an EXTRA tile (+3), and FINISH CATCHING compares only the order's garments to its total.
  - Once an extra size has been boxed on an order, its tile shows on that order's later box forms, Duplicate
    copies it, Edit Box can change it, and Report Misprint offers it as a size.
  - The server accepts a size that isn't on the order ONLY when it's marked extra, and only as a short
    size name on one of the order's own garments.
- **Save Box & New:** saves the box exactly like SAVE BOX; once Salesforce confirms, a fresh blank
  box form opens for the next box. If the save fails, everything typed stays on screen.
- **Duplicate Box:** every saved box has a DUPLICATE BOX button. It asks "How many duplicates would you
  like to create?" (whole number 1-100) and makes that many NEW records copying the box's Packaging Type,
  Packaging Quantity and Quantity + Size Counted. Each copy gets its own record ID and the next Garment
  Type number (Tees 3 -> Tees 4, Tees 5 ...). The original is never changed. All copies go to Salesforce
  in one all-or-nothing request (`/composite/sobjects`, allOrNone), so it's every copy or none.
  A timeout is shown as "not sure" and can't be re-run straight away.
  The box fields are defined once in `_boxes.js` and used by every way of creating a box.
- **Past Orders** (tab next to In Production): screen-print orders with boxes logged in the last
  30 days, newest first, read fresh from Salesforce. Each box shows Garment Type, Packaging Type,
  Quantity + Size Counted, who saved it and when.
- **7-day review window:** a box can be edited or deleted until exactly 7 days after Salesforce created it
  (`Order_Packaging__c.CreatedDate`). After that it's read-only and marked LOCKED. The server re-reads the
  box and checks the deadline on its own clock on every Edit and Delete, so a wrong tablet clock or a
  hidden button can't get round it.
- **Edit Box:** changes the same record (PATCH; same ID and CreatedDate): Garment Type word (the box
  number stays), Packaging Type and size counts; the total is re-added from the sizes. It's sent "only if
  nobody changed this box since it was read", so two edits can't silently overwrite each other.
- **Delete Box:** asks first, then deletes that one record (REST DELETE, the same way the dashboard's undo
  does; it goes to Salesforce's Recycle Bin). Checked 10-15: nothing in Salesforce looks up to Order
  Packaging, and it has no flows, triggers, validation rules or Rollup Helper rollups. If the order was
  already finished, its Packaging Count is set to the new number of boxes.
- **Sign-in (no timed sign-out, changed 10-16):** a catcher stays signed in until they tap their name
  to log out, or the app is refreshed -- every page load signs out and shows the PIN pad. The cookie
  is a browser-session cookie; the signed cookie keeps a 7-day safety limit on the server's clock so a
  copied cookie can't work forever. Signing out also cancels the sign-in on the server (KV
  `revoked:<id>`). If the server ever refuses a sign-in, unsaved entries are kept only for the SAME
  catcher and reopen when they sign in again; the next catcher never gets them.
- **No pull-down refresh (10-19):** `overscroll-behavior: none` on the page, so swiping down from the
  top of the tablet doesn't reload the app (a reload signs the catcher out).
- **Fulfillment (10-21):** while an order has no boxes, a FULFILLMENT button sits next to FINISH
  CATCHING. After a confirm step it writes `Packaging_Count__c = 0` (nothing else). The app shows a
  count of 0 with no boxes as "Fulfillment order. No boxes." on the card and the order. Like any
  finished order, it leaves the board once it's out of In Production. The server refuses it if the
  order has any boxes, so a real count is never replaced by 0.
- **Search (10-19):** a box above each list (In Production and Past Orders) filters the cards by order
  number or customer as you type (every word must match; "1234" also finds "SO-1234"). The list's own
  30-second refresh waits while someone is typing, so the keyboard doesn't close. Cleared when switching
  lists or signing out.
- **Progress on each order card (10-19):** "180 of 300 boxed · 4 boxes" plus a bar: grey while
  boxing, green when the boxes hold exactly the order's total, amber if they hold more.
- **Screen stays on (10-19):** while a catcher is signed in the app asks the browser for a screen wake
  lock, so the tablet doesn't dim or lock between orders. It's released on sign-out and asked for
  again when the app comes back to the front. Browsers without wake lock behave as before.
- **Counted By** (`Order_Packaging__c.CountedBy__c`, Text 80): the signed-in catcher, written on every
  new box and duplicate; an edit keeps the original counter. Salesforce's Created By always says
  "Catcher App" (one app login), so this is the field that says who counted. Older boxes fall back to
  Created By.
- **No jumping while counting:** the box form is updated in place (only the changed numbers and
  buttons), not rebuilt, so the form stays where it is while sizes are entered. The number pad stays
  pinned in view next to the lower sizes.
- **Stays on the board until counted:** once an order has been on the board, it stays
  there even if the print crew moves it to Post-Production early. It's marked
  "MOVED ON · FINISH COUNT" and listed first, until a catcher taps **FINISH CATCHING**.
  That writes the number of boxes to `Order.Packaging_Count__c` and the order leaves the
  board. (The board remembers which orders it has shown in KV, key `board:seen`, for 14 days.)
- **Report Misprint:** on the Order it adds to `TotalQtyMisprints__c` and adds one line to
  `Misprint_Details__c` under the "TOTAL QTY: NN" heading. The heading keeps the
  Total Quantity Misprints formula and the misprint-rate reports correct. Changing
  Misprint Details runs the "Printshop Misprint Process" flow, which notifies the print shop.
- Tap the mockup to open it full screen: pinch, double-tap or +/– to zoom, drag to move.
- – / + in the header makes the whole screen smaller or bigger (85%–175%). At larger
  sizes the screen switches to one column.

## Seasonal / holiday look (same as the production dashboard)

`seasonal.js` and the photos in `seasons/` are copied **unchanged** from the production
dashboard (`culture-apparel-production-main`). Both apps therefore always show the same theme:

- the season (Spring, Summer, Fall, Winter);
- or, during a holiday's Sunday–Saturday week, that holiday (New Year's, Valentine's,
  St. Patrick's, Easter, 4th of July, Halloween, Thanksgiving, Christmas).

When the dashboard's photos or `seasonal.js` change, copy them here again.

**Where the theme shows:**
- the photo strip behind "QUALITY MERCH. REAL IMPACT." in the header;
- the order list's title banner, with the season chip and the **Effects on/off** switch
  (saved per tablet);
- the PIN screen backdrop;
- a light falling animation (leaves, snow, bats…) that never blocks a tap and sits under
  the header and every form.

**Previewing a theme:** add `?theme=halloween` (or `christmas`, `july4`, `winter`…) to the URL.

**If anything fails, the app looks as before.** Nothing appears until the photo has
loaded. The animation is off for tablets set to reduce motion.

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
- The browser never sees Salesforce credentials or stored file links. Mockups are the
  JPG/PNG pictures in the Order's **Files** list (newest first; the big view flips
  between them). If an order has none, `Order.Artwork_URL__c` is used instead. Both are fetched by the server, and only for orders the app is
  allowed to show. The server checks what a file really is from its first bytes and
  only passes on JPG/PNG/GIF/WebP pictures and PDFs. Adobe Illustrator (.ai) files
  saved "PDF Compatible" (Illustrator's default) are PDFs inside, so they count as PDFs.
  The tablet draws a PDF's first page into a picture with pdf.js (`vendor/`, Mozilla,
  Apache 2.0 licence, served from this site). An .ai/.eps saved *without* a PDF copy
  can't be shown, and the card says so.

## Files

```
index.html, app.css, app.js     the tablet screen (no build step)
seasonal.js, seasons/           seasonal / holiday theme, copied from the production dashboard
vendor/                         pdf.js, which draws PDF / Illustrator mockups
_headers                        security headers
functions/api/                  the server (Cloudflare Pages Functions)
  _sf.js                        Salesforce connection (one org, client credentials)
  _session.js                   PIN sign-in, signed cookie, duplicate-save guard
  _orders.js                    which orders are shown, how one is read
  _mockup.js                    mockup lookup and fetch
  _sizes.js                     Quantity + Size Counted: writing and reading the size breakdown
  login.js logout.js me.js      sign-in
  orders.js                     GET  the order list
  box-types.js                  GET  active Packaging Type values
  boxes.js                      POST log one box
  misprints.js                  POST record a misprint
  duplicate-box.js              POST Duplicate Box (1-100 copies, all or nothing)
  _boxes.js                     the one definition of a box record's fields + box numbering
  past-orders.js                GET  Past Orders (last 30 days)
  box-edit.js                   POST Edit Box (7-day window)
  box-delete.js                 POST Delete Box (7-day window)
  finish.js                     POST finish catching (box count -> Packaging_Count__c)
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

**Optional:** `PRINTER_NAMES` (comma list overriding the two
printers), `SF_API_VERSION` (default `v61.0`).

**KV binding** (Settings → Bindings → KV namespace): variable name `CATCHER_KV`. This is
what slows down PIN guessing and stops duplicate saves. Without it the app still works,
but without those two protections.

## Salesforce (Production) setup

1. **Integration user.** A user only this app logs in as, given only the access below.
2. **Connected app** with OAuth "Client Credentials Flow" enabled, run as that user.
   Copy its Consumer Key and Consumer Secret into Cloudflare.
3. **Access the integration user needs:**
   - Order: Read, and Edit on `TotalQtyMisprints__c`, `Misprint_Details__c` and `Packaging_Count__c`.
     Read on the fields the list uses: `GOA_Order_Number__c`, `Order_Substatus__c`,
     `Printer__c`, `Print_Date__c`, `Specifications_for_Printing__c`, `Artwork_URL__c`.
   - Order Product (OrderItem): Read on `Size__c`, `Color__c`, Quantity, and the Product name.
   - Order Packaging (`Order_Packaging__c`): Read + Create + Edit + Delete, with Edit on Name,
     `Order__c`, `Packaging_Type__c`, `Packaging_Quantity__c` and `Quantity_Size_Counted__c`.
   - Mockups come from `Order.Artwork_URL__c`, a public file link, so no file access is needed.

## Tests

```
node tools/test.mjs
```

The tests run against a pretend Salesforce, with no network. They cover sign-in, the
PIN brake, the order filter, box and misprint saves, duplicate taps, timeouts, two
catchers at once, and validation-rule messages.
