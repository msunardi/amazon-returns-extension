import {
  MARKETPLACES, DEFAULT_MARKETPLACE, ORDERS_PATH, ORDERS_TIME_FILTER,
  ORDERS_PAGE_SIZE, MAX_PAGES, DAYS, originsFor, RETURNARY_DEFAULT_URL, SYNC_EVERY_MINUTES, returnaryOrigin,
  currencyFor,
} from '../lib/config.js';
import { expectedRefund, refundTotal } from '../lib/refunds.js';
import { parseOrderDetails, parseOrdersPage } from '../lib/parser.js';

const $ = (sel) => document.querySelector(sel);

const state = {
  consent: null,   // { domain, grantedAt }
  orders: [],
  lastScan: null,
  returns: {},     // itemKey -> captured return
  tracked: {},     // tabId -> { itemKey, ... } (open return windows)
  sync: {},        // itemKey -> Returnary sync state (see sync.js)
  returnary: {},   // Returnary settings: { enabled, url }
  returnaryStatus: {}, // { online, lastCheck, lastError }, from the background script
  scanning: false,
};

// ---- tiny DOM helper (always textContent, never innerHTML, for Amazon data)
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
const safeHttps = (url) => (typeof url === 'string' && url.startsWith('https://') ? url : null);
const setStatus = (msg) => { $('#status').textContent = msg || ''; };

// ---- startup ----------------------------------------------------------------
async function init() {
  const select = $('#marketSelect');
  for (const [domain, m] of Object.entries(MARKETPLACES)) {
    select.append(h('option', { value: domain, selected: domain === DEFAULT_MARKETPLACE }, m.label));
  }

  const local = await chrome.storage.local.get(['consent', 'orders', 'lastScan', 'returns', 'sync', 'returnary', 'returnaryStatus']);
  const { tracked = {}, returnLog: savedLog = [] } = await chrome.storage.session.get(['tracked', 'returnLog']);
  returnLog = savedLog;
  Object.assign(state, {
    consent: local.consent || null,
    orders: local.orders || [],
    lastScan: local.lastScan || null,
    returns: local.returns || {},
    sync: local.sync || {},
    returnary: local.returnary || {},
    returnaryStatus: local.returnaryStatus || {},
    tracked,
  });

  // Consent counts only while Chrome still holds the permission.
  if (state.consent && !(await chrome.permissions.contains({ origins: originsFor(state.consent.domain) }))) {
    state.consent = null;
    await chrome.storage.local.remove('consent');
  }

  $('#consentBtn').addEventListener('click', onConsent);
  $('#scanBtn').addEventListener('click', scan);
  $('#revokeBtn').addEventListener('click', onRevoke);
  $('#printBtn').addEventListener('click', () =>
    chrome.tabs.create({ url: chrome.runtime.getURL('src/receipt/receipt.html') }));
  $('#copyDiagBtn').addEventListener('click', async () => {
    await navigator.clipboard.writeText(
      `== Last scan ==\n${diag.join('\n\n') || '(none)'}\n\n== Return windows ==\n${returnLog.join('\n') || '(none)'}`,
    );
    setStatus('Troubleshooting details copied.');
  });
  $('#saveHtmlBtn').addEventListener('click', () => {
    if (lastPage) downloadText(lastPage.html, `amazon-orders-page-${lastPage.method}.html`, 'text/html');
  });
  $('#openAmazonBtn').addEventListener('click', () => {
    const base = MARKETPLACES[state.consent?.domain || DEFAULT_MARKETPLACE].base;
    chrome.tabs.create({ url: `${base}${ORDERS_PATH}` });
  });

  $('#rtEnabled').addEventListener('change', onReturnaryToggle);
  $('#rtSyncBtn').addEventListener('click', () => syncNow());
  $('#rtUrl').addEventListener('change', onReturnaryUrl);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && changes.returnLog) {
      returnLog = changes.returnLog.newValue || [];
      renderDiagnostics();
    }
    let changed = false;
    if (area === 'local' && changes.returns) {
      state.returns = changes.returns.newValue || {};
      $('#printBtn').disabled = Object.keys(state.returns).length === 0;
      changed = true;
    }
    if (area === 'local' && changes.sync) { state.sync = changes.sync.newValue || {}; changed = true; }
    if (area === 'local' && changes.returnary) { state.returnary = changes.returnary.newValue || {}; changed = true; }
    if (area === 'local' && changes.returnaryStatus) { state.returnaryStatus = changes.returnaryStatus.newValue || {}; changed = true; }
    if (area === 'session' && changes.tracked) { state.tracked = changes.tracked.newValue || {}; changed = true; }
    if (!changed) return;
    renderOrders();
    renderReturnary();
  });

  render();
  renderDiagnostics();
  if (state.returnary.enabled) queueEarlierReturns().then(() => syncNow(true));
}

// ---- consent ----------------------------------------------------------------
async function onConsent() {
  const domain = $('#marketSelect').value;
  // permissions.request must run directly in the click handler.
  const granted = await chrome.permissions.request({ origins: originsFor(domain) });
  if (!granted) {
    setStatus('Access was not granted, so nothing was scanned.');
    return;
  }
  state.consent = { domain, grantedAt: Date.now() };
  await chrome.storage.local.set({ consent: state.consent });
  render();
  scan();
}

async function onRevoke() {
  if (!confirm('Revoke access to Amazon and delete all saved orders and QR codes from this extension?')) return;
  if (state.consent) await chrome.permissions.remove({ origins: originsFor(state.consent.domain) });
  await chrome.storage.local.clear();
  Object.assign(state, { consent: null, orders: [], lastScan: null, returns: {} });
  setStatus('Access revoked and data deleted.');
  render();
}

// ---- scanning ---------------------------------------------------------------
function ordersUrl(base, page) {
  const url = new URL(ORDERS_PATH, base);
  url.searchParams.set('timeFilter', ORDERS_TIME_FILTER);
  if (page > 0) url.searchParams.set('startIndex', String(page * ORDERS_PAGE_SIZE));
  return url.href;
}

async function fetchPage(url) {
  const res = await fetch(url, { credentials: 'include' });
  return { html: await res.text(), finalUrl: res.url, httpStatus: res.status };
}

// Fallback: load the page in a background tab, the way a person would, and
// read the rendered HTML.
async function fetchPageViaTab(url) {
  const tab = await chrome.tabs.create({ url, active: false });
  try {
    await waitForTabComplete(tab.id);
    // Give scripts on the page a moment to finish rendering the order list.
    await new Promise((r) => setTimeout(r, 1500));
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => ({ html: document.documentElement.outerHTML, url: location.href }),
    });
    return { html: result.html, finalUrl: result.url, httpStatus: null };
  } finally {
    chrome.tabs.remove(tab.id).catch(() => {});
  }
}

function waitForTabComplete(tabId, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('Amazon took too long to load.')); }, timeoutMs);
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') { cleanup(); resolve(); }
    };
    function cleanup() { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(listener); }
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((t) => { if (t.status === 'complete') { cleanup(); resolve(); } });
  });
}

async function scan() {
  if (state.scanning || !state.consent) return;
  state.scanning = true;
  $('#signin').hidden = true;
  render();

  const base = MARKETPLACES[state.consent.domain].base;
  const found = new Map();
  diag.length = 0;
  diag.push(`Scan started ${new Date().toISOString()} · ${navigator.userAgent}`);

  // Reads one page with the given method, parses it and logs what came back.
  const read = async (method, url) => {
    const page = method === 'fetch' ? await fetchPage(url) : await fetchPageViaTab(url);
    lastPage = { html: page.html, method, url };
    const result = parseOrdersPage(page.html, page.finalUrl, base);
    diag.push(JSON.stringify({
      method, url, finalUrl: page.finalUrl, httpStatus: page.httpStatus,
      signedOut: result.signedOut, blocked: result.blocked,
      ordersParsed: result.orders.length,
      itemsParsed: result.orders.reduce((n, o) => n + o.items.length, 0),
      hasNext: result.hasNext, ...result.diagnostics,
    }, null, 1));
    return result;
  };

  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      setStatus(`Reading your orders… (page ${page + 1})`);
      const url = ordersUrl(base, page);
      let result = await read('fetch', url);
      // Retry in a real tab if the request did not carry the Amazon sign-in
      // (common in Firefox) or the page came back with no orders on it.
      if (result.signedOut || result.blocked || (page === 0 && !result.orders.length)) {
        setStatus('Retrying in a background tab…');
        result = await read('tab', url);
      }

      if (result.signedOut) return showSignin(false);
      if (result.blocked) return showSignin(true);

      const fresh = result.orders.filter((o) => !found.has(o.orderId));
      fresh.forEach((o) => found.set(o.orderId, o));
      if (!result.hasNext || fresh.length === 0) break;
    }

    const cutoff = Date.now() - DAYS * 24 * 60 * 60 * 1000;
    const all = [...found.values()];
    state.orders = all
      .filter((o) => o.orderTs == null || o.orderTs >= cutoff)
      .sort((a, b) => (b.orderTs ?? 0) - (a.orderTs ?? 0));
    diag.push(`Orders found: ${all.length}; kept after the ${DAYS}-day filter: ${state.orders.length}` +
      (all.length ? `; order dates read: ${all.map((o) => o.orderDate ?? '?').join(', ')}` : ''));
    state.lastScan = Date.now();
    await chrome.storage.local.set({ orders: state.orders, lastScan: state.lastScan });
    setStatus(
      state.orders.length
        ? `Found ${state.orders.length} order${state.orders.length === 1 ? '' : 's'}.`
        : 'No orders found in the last 30 days. If you expected some, Amazon may have changed its page layout (see README).',
    );
  } catch (err) {
    diag.push(`Error: ${err?.stack || err}`);
    setStatus(`Scan failed: ${err.message}`);
  } finally {
    state.scanning = false;
    render();
    renderDiagnostics();
  }
}

// ---- scan diagnostics -------------------------------------------------------
// Kept in memory only: the log has counts and URLs, the saved page has the
// raw HTML, and neither is written to storage.
const diag = [];
let lastPage = null;
let returnLog = []; // written by the service worker to storage.session

function renderDiagnostics() {
  $('#diag').hidden = diag.length === 0 && returnLog.length === 0;
  if (diag.length) $('#diagText').textContent = diag.join('\n\n');
  if (returnLog.length) $('#returnLogText').textContent = returnLog.join('\n');
  $('#saveHtmlBtn').disabled = !lastPage;
}

function downloadText(text, filename, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function showSignin(captcha) {
  $('#signinTitle').textContent = captcha ? 'Amazon wants to check you are not a robot' : "You're not signed in to Amazon";
  $('#signinText').textContent = captcha
    ? 'Open Amazon, complete the check, then click Scan orders again.'
    : 'Sign in to Amazon in this browser, then click Scan orders again.';
  $('#signin').hidden = false;
  setStatus('');
}

// ---- returns ----------------------------------------------------------------
async function startReturn(item, order) {
  const res = await chrome.runtime.sendMessage({
    type: 'open-return', itemKey: item.key, url: item.returnUrl,
    item: {
      title: item.title, image: item.image, url: item.url, asin: item.asin, returnWindow: item.returnWindow,
      orderId: order.orderId, orderDate: order.orderDate, orderTs: order.orderTs, total: order.total,
    },
  });
  if (!res?.ok) {
    setStatus(`Could not open the return window: ${res?.error || 'unknown error'}`);
    return;
  }
  setStatus('Complete the return in the Amazon window. The QR code will appear here once you confirm.');
  // Meanwhile, read the order's prices and quantities for Returnary.
  const orderItems = await orderDetails(order).catch(() => null);
  if (orderItems?.length) chrome.runtime.sendMessage({ type: 'order-details', itemKey: item.key, orderItems });
}

async function removeReturn(key) {
  if (!confirm('Remove the saved QR code for this item?')) return;
  const { returns = {} } = await chrome.storage.local.get('returns');
  delete returns[key];
  await chrome.storage.local.set({ returns });
}

function openLightbox(src, caption) {
  $('#lightboxImg').src = src;
  $('#lightboxCaption').textContent = caption;
  $('#lightbox').showModal();
}

// ---- rendering --------------------------------------------------------------
function render() {
  const hasConsent = !!state.consent;
  $('#consent').hidden = hasConsent;
  $('#scanBtn').hidden = !hasConsent;
  $('#revokeBtn').hidden = !hasConsent;
  $('#printBtn').hidden = !hasConsent;
  $('#returnaryPanel').hidden = !hasConsent;
  renderReturnary();
  $('#printBtn').disabled = Object.keys(state.returns).length === 0;
  $('#scanBtn').disabled = state.scanning;
  $('#scanBtn').textContent = state.scanning ? 'Scanning…' : 'Scan orders';

  const market = hasConsent ? MARKETPLACES[state.consent.domain].label : null;
  $('#subtitle').textContent = [
    `Orders from the last ${DAYS} days`,
    market,
    state.lastScan && `last scanned ${new Date(state.lastScan).toLocaleString()}`,
  ].filter(Boolean).join(' · ');

  renderOrders();
}

const formatMoney = (amount) => new Intl.NumberFormat(undefined, {
  style: 'currency', currency: currencyFor(state.consent?.domain),
}).format(amount);

function renderRefund(key) {
  const refund = expectedRefund(key, state.returns[key]);
  if (!refund) return h('span', {}, 'Expected refund: not shown by Amazon');
  return refund.source === 'amazon'
    ? h('span', { class: 'refund', title: `From Amazon: "${refund.text}"` }, `Expected refund: ${formatMoney(refund.amount)}`)
    : h('span', { class: 'refund estimate', title: 'Amazon showed no refund amount; this is the item price.' },
      `Expected refund: ≈ ${formatMoney(refund.amount)} (item price)`);
}

function renderRefundSummary() {
  const total = refundTotal(state.returns);
  $('#refundSummary').hidden = !state.consent || total.count === 0;
  $('#refundTotal').textContent = formatMoney(total.amount);
  const parts = [`${total.count} return${total.count === 1 ? '' : 's'}`];
  if (total.estimated) parts.push(`${total.estimated} estimated from the item price`);
  if (total.unknown) parts.push(`${total.unknown} without an amount, not counted`);
  $('#refundDetail').textContent = parts.join(' · ');
}

function renderOrders() {
  renderRefundSummary();
  const root = $('#orders');
  root.replaceChildren();
  if (!state.consent) return;
  if (!state.orders.length) {
    root.append(h('p', { class: 'empty' }, state.lastScan ? 'No orders to show.' : 'Click "Scan orders" to load your orders.'));
    return;
  }
  const pendingKeys = new Set(Object.values(state.tracked).filter((t) => !t.captured).map((t) => t.itemKey));
  for (const order of state.orders) root.append(renderOrder(order, pendingKeys));
}

function renderOrder(order, pendingKeys) {
  return h('section', { class: 'order' },
    h('div', { class: 'order-head' },
      h('span', {}, 'Order ', h('strong', {}, order.orderId)),
      order.orderDate && h('span', {}, 'Placed ', h('strong', {}, order.orderDate)),
      order.total && h('span', {}, 'Total ', h('strong', {}, order.total)),
      h('a', { href: safeHttps(order.detailsUrl), target: '_blank', rel: 'noopener' }, 'Order details'),
    ),
    order.items.length
      ? order.items.map((item) => renderItem(item, order, pendingKeys.has(item.key)))
      : h('div', { class: 'item' }, h('span'), h('span', { class: 'muted' }, 'No physical items detected in this order.')),
  );
}

function renderItem(item, order, pending) {
  const saved = state.returns[item.key];
  const image = safeHttps(item.image);
  return h('div', { class: 'item' },
    image ? h('img', { class: 'thumb', src: image, alt: '', loading: 'lazy' }) : h('span', { class: 'thumb blank' }),
    h('div', {},
      h('a', { class: 'item-title', href: safeHttps(item.url), target: '_blank', rel: 'noopener', title: item.title }, item.title),
      item.status && h('div', { class: 'meta' }, item.status),
      item.returnWindow && h('div', { class: 'meta' }, item.returnWindow),
    ),
    h('button', {
      class: saved ? '' : 'primary',
      onclick: () => startReturn(item, order),
      title: item.returnUrlGuessed ? 'No return link was found on the order page; this opens Amazon\'s returns page for the order.' : null,
    }, saved ? 'Open return again' : 'Start return'),
    h('div', { class: 'qr' }, renderQr(item, saved, pending)),
  );
}

function renderQr(item, saved, pending) {
  if (!saved) return pending ? h('span', { class: 'pending' }, 'Return window open — waiting for QR code…') : '—';

  const src = saved.qrDataUrl || safeHttps(saved.qrUrl);
  const when = new Date(saved.capturedAt).toLocaleString();
  return h('div', { class: 'qr-saved' },
    src && h('img', {
      class: 'qr-img', src, alt: `Return QR code for ${item.title}`,
      onclick: () => openLightbox(src, `${item.title}${saved.code ? ` · Code ${saved.code}` : ''}`),
    }),
    h('div', { class: 'qr-info' },
      h('span', { class: 'ok' }, src ? 'QR code saved' : 'Return confirmed'),
      saved.code && h('span', {}, `Code: ${saved.code}`),
      saved.returnBy && h('span', {}, saved.returnBy),
      saved.location && h('span', {}, saved.location),
      safeHttps(saved.labelUrl) && h('a', { href: saved.labelUrl, target: '_blank', rel: 'noopener' }, 'Return label'),
      !src && !saved.labelUrl && safeHttps(saved.pageUrl) &&
        h('a', { href: saved.pageUrl, target: '_blank', rel: 'noopener' }, 'Open confirmation page'),
      renderRefund(item.key),
      h('span', {}, `Saved ${when}`),
      renderSyncState(item.key),
      h('button', { class: 'link', onclick: () => removeReturn(item.key) }, 'Remove'),
    ),
  );
}

// ---- Returnary sync -----------------------------------------------------------
const detailsCache = new Map(); // orderId -> items from the order details page

async function orderDetails(order) {
  if (!state.consent || !order?.orderId) return null;
  if (detailsCache.has(order.orderId)) return detailsCache.get(order.orderId);
  const base = MARKETPLACES[state.consent.domain].base;
  const url = order.detailsUrl || `${base}/gp/your-account/order-details?orderID=${encodeURIComponent(order.orderId)}`;
  let page = await fetchPage(url);
  let result = parseOrderDetails(page.html, page.finalUrl, base);
  if (result.signedOut) {
    page = await fetchPageViaTab(url);
    result = parseOrderDetails(page.html, page.finalUrl, base);
  }
  const items = result.signedOut ? null : result.items;
  detailsCache.set(order.orderId, items);
  return items;
}

// Item details for a saved return, from the last scan.
function fromScan(key) {
  for (const order of state.orders) {
    const item = order.items.find((i) => i.key === key);
    if (item) {
      return { order, meta: {
        title: item.title, image: item.image, url: item.url, asin: item.asin, returnWindow: item.returnWindow,
        orderId: order.orderId, orderDate: order.orderDate, orderTs: order.orderTs, total: order.total,
      } };
    }
  }
  return null;
}

async function enqueueReturn(key) {
  const rec = state.returns[key];
  if (!rec) return;
  const scanned = fromScan(key);
  const order = scanned?.order || (rec.item?.orderId ? { orderId: rec.item.orderId } : null);
  const orderItems = rec.orderItems?.length ? null : await orderDetails(order).catch(() => null);
  await chrome.runtime.sendMessage({ type: 'enqueue', itemKey: key, item: rec.item || scanned?.meta, orderItems });
}

// Returns saved before syncing existed have no sync state yet: queue them once.
let queueing = null;
function queueEarlierReturns() {
  queueing ||= (async () => {
    for (const key of Object.keys(state.returns)) {
      if (!state.sync[key]) await enqueueReturn(key).catch((err) => console.warn('Could not queue', key, err));
    }
  })().finally(() => { queueing = null; });
  return queueing;
}

async function syncNow(quiet = false) {
  if (!quiet) setStatus('Syncing with Returnary…');
  const res = await chrome.runtime.sendMessage({ type: 'sync-now' }).catch((err) => ({ error: err.message }));
  if (quiet) return;
  if (res?.error) setStatus(`Sync failed: ${res.error}`);
  else if (!res?.enabled) setStatus('Turn on "Send returns to Returnary" first.');
  else if (!res.online) setStatus("Returnary isn't running. Returns stay queued and are sent when it is.");
  else setStatus(res.sent ? `Sent ${res.sent} return${res.sent === 1 ? '' : 's'} to Returnary.` : 'Returnary is up to date.');
}

async function onReturnaryToggle(e) {
  const enabled = e.target.checked;
  const origin = returnaryOrigin($('#rtUrl').value.trim() || RETURNARY_DEFAULT_URL);
  if (enabled) {
    if (!origin) {
      e.target.checked = false;
      setStatus('Returnary must be on this computer, for example http://127.0.0.1:5000.');
      return;
    }
    // permissions.request must be the first thing the click handler awaits.
    const granted = await chrome.permissions.request({ origins: [origin.pattern] });
    if (!granted) {
      e.target.checked = false;
      setStatus('Access to Returnary was not granted.');
      return;
    }
  }
  const { returnary = {} } = await chrome.storage.local.get('returnary');
  await chrome.storage.local.set({ returnary: { ...returnary, enabled, url: origin?.base || returnary.url || RETURNARY_DEFAULT_URL } });
  if (enabled) {
    await queueEarlierReturns();
    await syncNow();
  } else {
    setStatus('Syncing is off. New returns stay queued until you turn it back on.');
  }
}

async function onReturnaryUrl(e) {
  const origin = returnaryOrigin(e.target.value.trim());
  if (!origin) {
    setStatus('Returnary must be on this computer, for example http://127.0.0.1:5000.');
    e.target.value = state.returnary.url || RETURNARY_DEFAULT_URL;
    return;
  }
  const { returnary = {} } = await chrome.storage.local.get('returnary');
  // A different address may need its own permission: switch syncing off until it's switched on again.
  await chrome.storage.local.set({ returnary: { ...returnary, url: origin.base, enabled: false }, returnaryStatus: {} });
  setStatus('Address saved. Turn on "Send returns to Returnary" to connect.');
}

function renderReturnary() {
  const rt = { ...state.returnaryStatus, ...state.returnary };
  $('#rtEnabled').checked = !!rt.enabled;
  if (document.activeElement !== $('#rtUrl')) $('#rtUrl').value = rt.url || RETURNARY_DEFAULT_URL;
  $('#rtSyncBtn').disabled = !rt.enabled;
  const count = (status) => Object.entries(state.sync).filter(([k, s]) => s.status === status && state.returns[k]).length;
  const waiting = count('pending');
  const failed = count('failed');
  const queued = waiting ? `${waiting} return${waiting === 1 ? '' : 's'} waiting` : 'nothing waiting';
  const checked = rt.lastCheck ? ` · checked ${new Date(rt.lastCheck).toLocaleTimeString()}` : '';
  let text;
  if (!rt.enabled) text = `Off · ${queued}`;
  else if (rt.online === false) text = `Not reachable (${rt.lastError || 'offline'}) · ${queued}, retrying every ${SYNC_EVERY_MINUTES} minutes${checked}`;
  else if (rt.online) text = `Connected · ${queued}${checked}`;
  else text = `Not checked yet · ${queued}`;
  if (failed) text += ` · ${failed} could not be added`;
  $('#rtStatus').textContent = text;
  $('#rtStatus').className = rt.enabled && rt.online ? 'ok' : 'muted';
}

function renderSyncState(key) {
  const s = state.sync[key];
  if (!s) return state.returnary.enabled ? h('span', { class: 'muted' }, 'Returnary: not queued yet') : null;
  const hasQr = !!(state.returns[key]?.qrDataUrl || state.returns[key]?.qrUrl); // label returns have none
  if (s.status === 'synced' && s.qrInReturnary === false && hasQr) {
    return h('span', { class: 'warn' },
      s.returnsUrl ? h('a', { href: s.returnsUrl, target: '_blank', rel: 'noopener' }, 'In Returnary') : 'In Returnary',
      ` without the QR code: ${s.qrProblem || 'unknown reason'}. `,
      h('button', { class: 'link', onclick: () => enqueueReturn(key) }, 'Retry'));
  }
  if (s.status === 'synced') {
    const label = s.already ? 'Already in Returnary' : 'Added to Returnary';
    return s.returnsUrl
      ? h('a', { href: s.returnsUrl, target: '_blank', rel: 'noopener', class: 'ok' }, `${label} ↗`)
      : h('span', { class: 'ok' }, label);
  }
  if (s.status === 'pending') return h('span', { class: 'pending' }, 'Waiting to sync with Returnary');
  return h('span', { class: 'warn' }, `Not added to Returnary: ${s.lastError || 'error'} `,
    h('button', { class: 'link', onclick: () => enqueueReturn(key) }, 'Retry'));
}

init();
