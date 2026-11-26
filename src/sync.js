// Sends saved returns to Returnary (the local purchase tracker), and keeps
// them queued while it isn't running.
//
// Storage (chrome.storage.local):
//   returnary        { enabled, url }                (written by the dashboard)
//   returnaryStatus  { online, lastCheck, lastError } (written here)
//   sync       { [itemKey]: { status: 'pending' | 'synced' | 'failed', attempts,
//                             lastError, lastAttempt, syncedAt, returnsUrl, already } }
// A return is queued (status 'pending') as soon as it is saved, whether or
// not syncing is switched on; switching it on sends everything waiting.
import {
  RETURNARY_DEFAULT_URL, RETURNARY_CLIENT, SYNC_EVERY_MINUTES, currencyFor, returnaryOrigin,
} from './lib/config.js';

export const ALARM = 'returnary-sync';
const MAX_ATTEMPTS = 5; // for errors from Returnary itself; "offline" never counts

// ---- one writer at a time -----------------------------------------------------
// Every read-modify-write of storage goes through here, so a capture, a sync
// result and a dashboard update can't overwrite each other.
let chain = Promise.resolve();
export function locked(fn) {
  const run = chain.then(fn);
  chain = run.catch(() => {});
  return run;
}

export async function getSettings() {
  const { returnary = {} } = await chrome.storage.local.get('returnary');
  return { enabled: false, url: RETURNARY_DEFAULT_URL, ...returnary };
}

export function queue(itemKey) {
  return locked(async () => {
    const { sync = {} } = await chrome.storage.local.get('sync');
    if (sync[itemKey]?.status !== 'pending') sync[itemKey] = { status: 'pending', attempts: 0, queuedAt: Date.now() };
    await chrome.storage.local.set({ sync });
  });
}

function setState(changes) {
  return locked(async () => {
    const { sync = {}, returnaryStatus = {} } = await chrome.storage.local.get(['sync', 'returnaryStatus']);
    for (const [key, value] of Object.entries(changes.items || {})) sync[key] = { ...sync[key], ...value };
    await chrome.storage.local.set({ sync, returnaryStatus: { ...returnaryStatus, ...(changes.status || {}) } });
  });
}

// ---- building what Returnary receives -----------------------------------------
const money = (s) => {
  const n = Number(String(s ?? '').replace(/[^\d.]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
};
const isoDate = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function isoFromText(text) {
  const m = (text || '').match(/([A-Za-z]+\.?\s+\d{1,2},?\s+\d{4}|\d{1,2}\s+[A-Za-z]+\.?\s+\d{4})/);
  const ts = m ? Date.parse(m[1].replace('.', '')) : NaN;
  return Number.isNaN(ts) ? null : isoDate(new Date(ts));
}
// Returnary keeps PNG/JPEG/WEBP/GIF.
const storableImage = (url) => (/^data:image\/(png|jpeg|webp|gif);base64,/.test(url || '') ? url : null);

async function buildPayload(itemKey, rec, domain, fetchImage) {
  const item = rec.item;
  if (!item?.orderId) throw new Error('Item details are missing. Open the dashboard to fill them in.');
  const asin = item.asin || itemKey.split('|')[1] || null;
  const details = rec.orderItems || [];
  const mine = details.find((i) => i.asin === asin);
  const photo = async (url) => (url ? fetchImage(url).catch(() => null) : null);

  const items = await Promise.all(details.slice(0, 20).map(async (i) => ({
    asin: i.asin, name: i.title, price: i.price, quantity: i.quantity,
    photo: storableImage(await photo(i.image)),
  })));
  if (!mine) items.push({ asin, name: item.title, price: null, quantity: 1, photo: storableImage(await photo(item.image)) });

  return {
    order: {
      orderId: item.orderId,
      orderDate: item.orderTs ? isoDate(new Date(item.orderTs)) : isoFromText(item.orderDate),
      total: money(item.total),
      currency: currencyFor(domain),
      returnBy: isoFromText(item.returnWindow),
    },
    items,
    item: { asin, name: mine?.title || item.title, price: mine?.price ?? null, quantity: mine?.quantity ?? 1 },
    return: { qr: storableImage(rec.qrDataUrl), code: rec.code || null },
  };
}

// ---- talking to Returnary ------------------------------------------------------
const HEADERS = { 'X-Returnary-Client': RETURNARY_CLIENT };

async function isOnline(base) {
  try {
    const res = await fetch(`${base}/api/ping`, { headers: HEADERS, signal: AbortSignal.timeout(3000) });
    return res.ok && (await res.json()).app === 'returnary';
  } catch {
    return false;
  }
}

let running = null;
/** Send every queued return. Safe to call often: runs one sync at a time. */
export function syncNow(fetchImage) {
  running ||= doSync(fetchImage).finally(() => { running = null; });
  return running;
}

async function doSync(fetchImage) {
  const settings = await getSettings();
  const origin = returnaryOrigin(settings.url);
  if (!settings.enabled || !origin) return { enabled: settings.enabled, online: null, sent: 0 };
  if (!(await chrome.permissions.contains({ origins: [origin.pattern] }))) {
    await setState({ status: { online: false, lastCheck: Date.now(), lastError: 'No permission to reach Returnary. Turn syncing off and on again.' } });
    return { enabled: true, online: false, sent: 0 };
  }

  const online = await isOnline(origin.base);
  await setState({ status: { online, lastCheck: Date.now(), lastError: online ? null : 'Returnary is not running.' } });
  if (!online) return { enabled: true, online: false, sent: 0 };

  const { sync = {}, returns = {}, consent = {} } = await chrome.storage.local.get(['sync', 'returns', 'consent']);
  let sent = 0;
  for (const [key, state] of Object.entries(sync)) {
    if (state.status !== 'pending' || !returns[key]) continue;
    const attempts = (state.attempts || 0) + 1;
    let payload;
    try {
      payload = await buildPayload(key, returns[key], consent.domain, fetchImage);
    } catch (err) {
      await setState({ items: { [key]: { status: 'failed', attempts, lastError: err.message, lastAttempt: Date.now() } } });
      continue;
    }
    let res, body;
    try {
      res = await fetch(`${origin.base}/api/amazon/returns`, {
        method: 'POST',
        headers: { ...HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30000),
      });
      body = await res.json().catch(() => ({}));
    } catch {
      // Returnary went away mid-sync: keep the rest queued for next time.
      await setState({ status: { online: false, lastError: 'Returnary stopped responding.' } });
      break;
    }
    if (res.ok && body.ok) {
      sent++;
      await setState({ items: { [key]: {
        status: 'synced', attempts, lastError: null, syncedAt: Date.now(), already: !!body.already_there,
        returnsUrl: body.returns_url ? `${origin.base}${body.returns_url}` : null,
      } } });
    } else {
      const error = body.error || `Returnary answered ${res.status}.`;
      // A 400 means Returnary can't use this return: retrying won't help.
      const status = res.status === 400 || attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
      await setState({ items: { [key]: { status, attempts, lastError: error, lastAttempt: Date.now() } } });
    }
  }
  return { enabled: true, online: true, sent };
}

export async function ensureAlarm() {
  if (!(await chrome.alarms.get(ALARM))) chrome.alarms.create(ALARM, { periodInMinutes: SYNC_EVERY_MINUTES });
}
