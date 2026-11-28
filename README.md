# Amazon Return Manager (Chrome and Firefox extension)

A browser extension for **Chrome** and **Firefox** that shows your Amazon orders from the last 30 days on one dashboard. Start a return in one click, and keep the return QR code next to each item.

One folder serves both browsers: there is no build step and no separate Firefox version. `manifest.json` holds the settings each browser needs, and each browser ignores the other's.

| | Chrome | Firefox |
|---|---|---|
| Minimum version | 116 | 140 (desktop) |
| Background code runs as | a service worker | a background script |
| Install for development | **Load unpacked** | **Load Temporary Add-on…** |
| Permanent install | Chrome Web Store, or keep loading it unpacked | Signed by Mozilla (`web-ext sign`) |

## Install

You need to be signed in to Amazon in the same browser profile.

### Firefox (desktop, version 140 or later)

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…** and pick `manifest.json` in this folder.
3. Click the extension's toolbar icon to open the dashboard. You may need to pin it from the puzzle-piece menu first.
4. Choose your Amazon store, click **Allow and scan my orders**, then accept Firefox's permission prompt.

A temporary add-on is removed when Firefox restarts. To keep it installed, Mozilla has to sign it:

1. Change `browser_specific_settings.gecko.id` in `manifest.json` to an ID of your own.
2. Run `npx web-ext sign --channel=unlisted` with your AMO API keys.
3. Install the `.xpi` file it creates.

Keep the API keys out of the repository: `.env` files are already in `.gitignore`.

Firefox for Android is not supported, because it has no popup windows.

### Chrome (version 116 or later)

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick this folder (the one with `manifest.json`).
3. Click the extension's toolbar icon to open the dashboard.
4. Choose your Amazon store, click **Allow and scan my orders**, then accept Chrome's permission prompt.

### Differences between the browsers

- **Toolbar icon:** in Chrome it switches to an open dashboard tab. In Firefox it always opens a new one, because `runtime.getContexts` is Chrome-only.
- **Amazon sign-in:** Firefox's cookie protection can stop a direct request from carrying your Amazon sign-in. The scan then reads the page in a background tab instead, which can happen in either browser.
- **Background code:** in Chrome it runs as a service worker; in Firefox, as a background script. The same `src/background.js` serves both.

To check the manifest against Firefox's rules, run `npx web-ext lint`. Two warnings are expected:
- `background.service_worker` is ignored by Firefox. Chrome needs it.
- Firefox for Android doesn't support a manifest key at the minimum version. The extension doesn't support Android anyway.

## How it works

| Step | What happens | Code |
|---|---|---|
| Consent | Nothing is read until you click **Allow**. Amazon access is an *optional* host permission that the browser asks you to confirm. You can revoke it and delete all data from the dashboard. | `dashboard.js` → `onConsent` |
| Scan | Fetches `/your-orders/orders?timeFilter=last30` (up to 5 pages) with your existing Amazon cookies and parses the HTML. If Amazon serves a sign-in or robot-check page, or a page with no orders on it, it retries once in a background tab. | `dashboard.js` → `scan`, `lib/parser.js` |
| Start return | Opens the item's "Return or replace items" link in a **browser popup window** and remembers which item that window belongs to. It also reads the order's details page for item prices and quantities. | `background.js` → `openReturn` |
| Capture QR | Injects `return-watcher.js` into **that window only**. It watches the page; when the confirmation page shows a QR code, it captures the image, plus the return code, drop-off deadline, location, label link and expected refund when it can find them. A bar in the window's corner shows what it is doing and turns green once the QR code is saved. If automatic detection misses, click **Pick QR code** on that bar, then click the QR code. | `content/return-watcher.js`, `background.js` → `saveCapture` |
| Show | The dashboard updates live from the extension's storage. Click a QR code to enlarge it for scanning at the drop-off counter. | `dashboard.js` → `renderQr` |

All data stays in the extension's local storage on your computer, unless you turn on sending returns to Returnary (see below), which also runs on this computer.

### Why a popup window and not an in-page modal

Amazon sends `X-Frame-Options` / `frame-ancestors` headers, so its pages refuse to load inside an iframe. Getting around that means stripping the headers, which is fragile and weakens security, so this extension uses a real popup window instead.

### Expected refunds

While you go through Amazon's return flow, the watcher looks for the refund amount Amazon shows ("Estimated refund", "Refund total", "You'll receive a refund of …"). Usually it is on the review step before you confirm, and sometimes again on the confirmation page. It keeps the latest amount seen up to the moment the QR code is saved. Afterwards it only fills one in if none was found, so a later page can't replace it.

Each saved return on the dashboard shows its **Expected refund**. Hover over it to see the wording it was read from. When Amazon showed no amount, the item's price × quantity from the order details page is used instead and marked "≈ … (item price)". The summary above the orders adds up all saved returns and says how many amounts are estimates or unknown. The printed receipt shows the same per item, with a total for the selected items.

If an amount isn't picked up, the return window's log (Troubleshooting details) shows the `refundText` the watcher saw on each page. The patterns are `REFUND_TEXT` in `src/content/return-watcher.js`.

### Return receipt

**Print return receipt** on the dashboard opens every saved return as an 80 mm receipt column, which fits receipt printers and prints fine on plain paper. Each item is shown with its picture, name, order number, expected refund and QR code, plus the return code, drop-off deadline and location when they were captured. Items that share one QR code (one Amazon return) print under a single code. Untick items you've already dropped off, then click **Print**. Item details are saved with each return, so returns from orders older than the last scan still print with their names.

### Sending returns to Returnary

[Returnary](../Returnary) is the local purchase tracker in the folder next to this one. Tick **Send returns to Returnary** on the dashboard. The browser asks once for access to the app's address: the default is `http://127.0.0.1:5000`, and only addresses on this computer are accepted.

- **Queue:** each return is queued as soon as its QR code is saved, even while syncing is off. Returns saved before this feature are queued when you turn syncing on.
- **Sending:** when Returnary is running, queued returns are sent right away. While it isn't running, they wait and are retried every 5 minutes, when the browser starts, when you open the dashboard, and when you click **Sync now**.
- **Prices:** when you click **Start return**, the dashboard also reads the order's details page, so Returnary gets each item's price and quantity.
- **No duplicates:** Returnary only adds what it doesn't have yet: the purchase (matched by order number), the item (matched by ASIN or name) and the return (only its QR code and return number are filled in if missing). Sending a return twice changes nothing.
- **QR codes:** Returnary stores PNG, JPEG, WEBP and GIF images. A QR code in any other format, such as SVG, is converted to PNG before sending. A QR code saved only as a link is downloaded first. Returnary replies whether the return has a QR code. If a saved one didn't arrive, the item shows "In Returnary without the QR code" with the reason, and **Retry**.
- **Status:** each item on the dashboard shows "Waiting to sync", "Added to Returnary ↗" / "Already in Returnary ↗" (opens it there), or why it couldn't be added, with **Retry**.

Code: `src/sync.js` (queue and sending), `src/lib/parser.js` → `parseOrderDetails`. Returnary's side is `amazon_import.py` and the `/api/...` routes in its `app.py`.

## Known limitations

- **Amazon has no public API for this.** Orders and QR codes are read from Amazon's HTML, and Amazon changes its markup without notice. All order-page selectors are in `SELECTORS` / `PATTERNS` in `src/lib/parser.js`; all confirmation-page patterns are at the top of `src/content/return-watcher.js`. Those are the places to fix things when a scan or capture breaks. **Troubleshooting details** on the dashboard shows what each step saw.
- **Tested in Firefox.** Scanning orders and capturing QR codes work in Firefox on a real Amazon account. Chrome uses the same code but hasn't been tried on a real account yet.
- **Returns are per order.** Amazon's return flow starts at the order; you pick the item inside Amazon's flow. The QR code is saved against the item you clicked **Start return** on. If one QR code covers several items, it is saved only under that one item.
- **Label-only returns.** If Amazon gives a printable label instead of a QR code, the dashboard saves the label link (or the confirmation page link) instead.
- **English storefronts only** (US, CA, UK), because the parser matches English labels.
- **Terms of use.** Amazon's Conditions of Use restrict automated data collection. This extension only reads your own account, and only when you click a button, but it is a personal tool and not approved by Amazon. Publishing it on the Chrome Web Store or Firefox Add-ons could get it rejected or taken down.

## Project layout

```
manifest.json                 one manifest for Chrome and Firefox
src/
  background.js               background code (Chrome service worker / Firefox background script):
                              return windows, injection, saving captures
  sync.js                     queue and sending to Returnary
  lib/config.js               storefronts, URLs, permissions, Returnary settings
  lib/parser.js               order-history and order-details HTML → orders/items
  lib/refunds.js              expected refund per return, and totals
  content/return-watcher.js   runs in return windows: finds the QR code and refund amount
  dashboard/                  dashboard page (html, css, js)
  receipt/                    printable return receipt (html, css, js)
```

## Debugging

| | Firefox | Chrome |
|---|---|---|
| Dashboard | Right-click the page → **Inspect** | Right-click the page → **Inspect** |
| Background code | `about:debugging#/runtime/this-firefox` → **Inspect** under the extension | `chrome://extensions` → **Inspect views: service worker** |
| Return watcher | Open the developer tools in the return popup window | Open DevTools in the return popup window and choose the extension in the Console's context dropdown |
| Reload after changes | `about:debugging` → **Reload** | `chrome://extensions` → reload icon |

**Troubleshooting details** at the bottom of the dashboard logs what the last scan and each return window saw, in both browsers.
