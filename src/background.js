// Service worker: opens the dashboard, opens return windows, injects the
// QR watcher into them, and saves what the watcher captures.
import { isMarketplaceUrl } from './lib/config.js';
import { ALARM, ensureAlarm, locked, queue, syncNow } from './sync.js';

const DASHBOARD_URL = chrome.runtime.getURL('src/dashboard/dashboard.html');
const WATCHER_FILE = 'src/content/return-watcher.js';

// ---- tracked return windows -------------------------------------------------
// tracked: { [tabId]: { itemKey, windowId, openedAt, captured } }
// Kept in storage.session because the service worker can be stopped at any
// time; the dashboard reads it too, to show "waiting for QR".
async function getTracked() {
  const { tracked = {} } = await chrome.storage.session.get('tracked');
  return tracked;
}
async function setTracked(tracked) {
  await chrome.storage.session.set({ tracked });
}

// ---- toolbar button opens (or focuses) the dashboard ------------------------
chrome.action.onClicked.addListener(async () => {
  // runtime.getContexts is Chrome-only; Firefox just opens a new dashboard tab.
  const [ctx] = chrome.runtime.getContexts
    ? await chrome.runtime.getContexts({ contextTypes: ['TAB'], documentUrls: [DASHBOARD_URL] })
    : [];
  if (ctx) {
    await chrome.tabs.update(ctx.tabId, { active: true });
    await chrome.windows.update(ctx.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: DASHBOARD_URL });
  }
});

// ---- messages ---------------------------------------------------------------
const handlers = {
  'open-return': openReturn,
  'qr-captured': saveCapture,
  'watcher-status': watcherStatus,
  'watcher-log': watcherLog,
  'order-details': saveOrderDetails,
  'refund-seen': saveRefund,
  'enqueue': enqueue,
  'sync-now': (_msg, sender) => fromDashboard(sender, () => syncNow(fetchImageForSync)),
};

const fromDashboard = (sender, fn) =>
  sender.url?.split('#')[0] === DASHBOARD_URL ? fn() : Promise.resolve({ ok: false, error: 'Not allowed' });

// ---- Returnary sync -----------------------------------------------------------
const fetchImageForSync = (url) => (isFetchableImage(url) ? fetchAsDataUrl(url) : Promise.resolve(null));
const startSync = () => syncNow(fetchImageForSync).catch((err) => console.warn('Returnary sync failed:', err));

chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === ALARM) startSync(); });
chrome.runtime.onStartup.addListener(() => { ensureAlarm(); startSync(); });
chrome.runtime.onInstalled.addListener(() => { ensureAlarm(); });
ensureAlarm();

function cleanRefund(refund) {
  const amount = Number(refund?.amount);
  if (!(amount >= 0 && amount < 100000)) return null;
  return { amount: Math.round(amount * 100) / 100, text: String(refund.text || '').slice(0, 120), seenAt: Date.now() };
}

function cleanOrderItems(list) {
  if (!Array.isArray(list)) return null;
  return list.slice(0, 50).map((i) => ({
    asin: typeof i.asin === 'string' ? i.asin.slice(0, 20) : null,
    title: typeof i.title === 'string' ? i.title.slice(0, 500) : '',
    price: typeof i.price === 'number' && i.price >= 0 ? i.price : null,
    quantity: Number.isInteger(i.quantity) && i.quantity > 0 ? i.quantity : 1,
    image: typeof i.image === 'string' && i.image.startsWith('https://') ? i.image.slice(0, 2000) : null,
  })).filter((i) => i.title);
}

// The watcher saw Amazon's expected refund in a return window. Before the QR
// code is saved, the latest amount wins (it can change with the return
// method); afterwards it only fills in a missing one, so a later page (for
// example a list of other returns) can't replace it.
function saveRefund({ refund }, sender) {
  const tabId = sender.tab?.id;
  const amount = Number(refund?.amount);
  if (!(amount >= 0 && amount < 100000)) return Promise.resolve({ ok: false });
  const clean = { amount: Math.round(amount * 100) / 100, text: String(refund.text || '').slice(0, 120), seenAt: Date.now() };
  return locked(async () => {
    const tracked = await getTracked();
    const entry = tracked[tabId];
    if (!entry) return { ok: false };
    if (!entry.captured) {
      entry.refund = clean;
      await setTracked(tracked);
      return { ok: true };
    }
    const { returns = {} } = await chrome.storage.local.get('returns');
    const rec = returns[entry.itemKey];
    if (rec && !rec.refund) {
      rec.refund = clean;
      await chrome.storage.local.set({ returns });
    }
    return { ok: true };
  });
}

// The dashboard read the order's details page (prices, quantities) after
// opening a return window: keep them with the return.
function saveOrderDetails({ itemKey, orderItems }, sender) {
  return fromDashboard(sender, () => locked(async () => {
    const items = cleanOrderItems(orderItems);
    if (!items) return { ok: false };
    const tracked = await getTracked();
    for (const entry of Object.values(tracked)) if (entry.itemKey === itemKey) entry.orderItems = items;
    await setTracked(tracked);
    const { returns = {} } = await chrome.storage.local.get('returns');
    if (returns[itemKey]) {
      returns[itemKey].orderItems = items;
      await chrome.storage.local.set({ returns });
    }
    return { ok: true };
  }));
}

// The dashboard queues returns saved before syncing existed, and retries
// failed ones, filling in item details it has from the last scan.
function enqueue({ itemKey, item, orderItems }, sender) {
  return fromDashboard(sender, async () => {
    const ok = await locked(async () => {
      const { returns = {} } = await chrome.storage.local.get('returns');
      const rec = returns[itemKey];
      if (!rec) return false;
      if (!rec.item && item) rec.item = itemMeta(item);
      const items = cleanOrderItems(orderItems);
      if (items?.length && !rec.orderItems?.length) rec.orderItems = items;
      await chrome.storage.local.set({ returns });
      return true;
    });
    if (!ok) return { ok: false, error: 'No saved return for this item' };
    await queue(itemKey);
    startSync();
    return { ok: true };
  });
}

// ---- troubleshooting log for return windows (session storage only) ---------
let logChain = Promise.resolve();
function appendLog(tabId, event, data) {
  const line = `${new Date().toLocaleTimeString()} tab ${tabId} ${event}` +
    (data && Object.keys(data).length ? ` ${JSON.stringify(data, null, 1)}` : '');
  logChain = logChain.then(async () => {
    const { returnLog = [] } = await chrome.storage.session.get('returnLog');
    returnLog.push(line);
    await chrome.storage.session.set({ returnLog: returnLog.slice(-150) });
  }).catch(() => {});
  return logChain;
}
const stripQuery = (u) => { try { const x = new URL(u); return x.origin + x.pathname; } catch { return String(u); } };

async function watcherStatus(_msg, sender) {
  const entry = (await getTracked())[sender.tab?.id];
  return { ok: true, tracked: !!entry, captured: !!entry?.captured };
}

async function watcherLog({ event, data }, sender) {
  const tabId = sender.tab?.id;
  if (!(await getTracked())[tabId]) return { ok: false };
  await appendLog(tabId, `watcher: ${String(event).slice(0, 40)}`, data);
  return { ok: true };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = handlers[msg?.type];
  if (!handler) return false;
  handler(msg, sender)
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
  return true; // keep the channel open for the async response
});

// Item details kept with a saved return, so it can be printed even after its
// order is no longer in the last-30-days scan.
function itemMeta(item = {}) {
  const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : null);
  const https = (v) => (typeof v === 'string' && v.startsWith('https://') ? v.slice(0, 2000) : null);
  return {
    title: text(item.title, 500), image: https(item.image), url: https(item.url),
    asin: text(item.asin, 20), orderId: text(item.orderId, 40), orderDate: text(item.orderDate, 40),
    orderTs: typeof item.orderTs === 'number' ? item.orderTs : null, total: text(item.total, 40),
    returnWindow: text(item.returnWindow, 120),
  };
}

async function openReturn({ itemKey, url, item }, sender) {
  // Only our own dashboard may open return windows.
  if (sender.url?.split('#')[0] !== DASHBOARD_URL) return { ok: false, error: 'Not allowed' };
  if (!isMarketplaceUrl(url)) return { ok: false, error: 'Not an Amazon URL' };

  const existing = Object.values(await getTracked()).find((t) => t.itemKey === itemKey);
  if (existing) {
    try {
      await chrome.windows.update(existing.windowId, { focused: true });
      return { ok: true, reused: true };
    } catch {
      // The window is gone; fall through and open a new one.
    }
  }

  const win = await chrome.windows.create({
    url,
    type: 'popup',
    width: 600,
    height: 900,
    focused: true,
  });
  const tabId = win.tabs[0].id;
  await locked(async () => {
    const tracked = await getTracked();
    tracked[tabId] = { itemKey, item: itemMeta(item), windowId: win.id, openedAt: Date.now(), captured: false };
    await setTracked(tracked);
  });
  await appendLog(tabId, 'return window opened', { url: stripQuery(url) });

  // If the page finished loading before we saved the tracking entry,
  // onUpdated has already fired: inject now.
  const tab = await chrome.tabs.get(tabId);
  if (tab.status === 'complete') await injectWatcher(tabId);
  return { ok: true };
}

async function saveCapture({ payload }, sender) {
  const tabId = sender.tab?.id;
  const tracked = await getTracked();
  const entry = tracked[tabId];
  if (!entry) return { ok: false, error: 'This window was not opened by the dashboard' };

  let qrDataUrl = payload.qrDataUrl || null;
  if (!qrDataUrl && payload.qrUrl) {
    if (!isFetchableImage(payload.qrUrl)) {
      await appendLog(tabId, 'QR image is on a host we cannot fetch', { url: stripQuery(payload.qrUrl) });
    } else {
      qrDataUrl = await fetchAsDataUrl(payload.qrUrl).catch(async (err) => {
        await appendLog(tabId, 'QR image fetch failed', { error: String(err?.message || err) });
        return null;
      });
    }
  }

  await locked(async () => {
    const { returns = {} } = await chrome.storage.local.get('returns');
    const fresh = (await getTracked())[tabId] || entry; // order details may have arrived meanwhile
    returns[entry.itemKey] = {
      qrDataUrl,
      qrUrl: payload.qrUrl || null,
      code: payload.code || null,
      returnBy: payload.returnBy || null,
      location: payload.location || null,
      labelUrl: payload.labelUrl || null,
      pageUrl: payload.pageUrl || null,
      capturedAt: Date.now(),
      item: entry.item || null,
      orderItems: fresh.orderItems || returns[entry.itemKey]?.orderItems || null,
      refund: cleanRefund(payload.refund) || fresh.refund || null,
    };
    await chrome.storage.local.set({ returns });
    const latest = await getTracked();
    if (latest[tabId]) latest[tabId].captured = true;
    await setTracked(latest);
  });
  await queue(entry.itemKey);
  startSync();
  await appendLog(tabId, 'saved', { hasImage: !!qrDataUrl, code: !!payload.code, labelUrl: !!payload.labelUrl });
  return { ok: true, hasImage: !!qrDataUrl };
}

function isFetchableImage(url) {
  try {
    const { protocol, hostname } = new URL(url);
    return (
      protocol === 'https:' &&
      (isMarketplaceUrl(url) ||
        hostname.endsWith('.media-amazon.com') ||
        hostname.endsWith('.ssl-images-amazon.com'))
    );
  } catch {
    return false;
  }
}

async function fetchAsDataUrl(url) {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  if (!blob.type.startsWith('image/')) throw new Error('Not an image');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return `data:${blob.type};base64,${btoa(bin)}`;
}

// ---- inject the watcher into tracked return windows -------------------------
async function injectWatcher(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: [WATCHER_FILE] });
  } catch (err) {
    // For example the tab navigated off Amazon, where we have no access.
    const url = await chrome.tabs.get(tabId).then((t) => t.url, () => '?');
    await appendLog(tabId, 'watcher NOT injected', { url: stripQuery(url || '?'), error: String(err?.message || err) });
  }
}

// Inject on every page load, also after a capture, so the user can still
// pick a different QR code.
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status !== 'complete') return;
  if ((await getTracked())[tabId]) await injectWatcher(tabId);
});

chrome.windows.onRemoved.addListener((windowId) => locked(async () => {
  const tracked = await getTracked();
  let changed = false;
  for (const [tabId, t] of Object.entries(tracked)) {
    if (t.windowId === windowId) {
      delete tracked[tabId];
      changed = true;
    }
  }
  if (changed) await setTracked(tracked);
}));
