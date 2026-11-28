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
// ---- images ---------------------------------------------------------------------
// Returnary keeps PNG/JPEG/WEBP/GIF. Anything else (Amazon can draw QR codes
// as SVG) is redrawn as a PNG first.
const STORABLE = /^data:image\/(png|jpeg|webp|gif);base64,/;
const MIN_QR_EDGE = 480; // SVGs have no pixel size: draw them large enough to scan

async function toPngDataUrl(dataUrl) {
  const blob = await (await fetch(dataUrl)).blob();
  let source = await createImageBitmap(blob).catch(() => null); // raster images, in any context
  let width = source?.width;
  let height = source?.height;
  if (!source && typeof Image !== 'undefined') {
    // SVG: needs an <img>, which Firefox's background script has (Chrome's service worker doesn't).
    const img = new Image();
    img.src = dataUrl;
    await img.decode();
    source = img;
    width = img.naturalWidth || MIN_QR_EDGE;
    height = img.naturalHeight || MIN_QR_EDGE;
  }
  if (!source) throw new Error('This browser cannot convert the image');
  const scale = Math.max(1, MIN_QR_EDGE / Math.max(width, height));
  const canvas = new OffscreenCanvas(Math.round(width * scale), Math.round(height * scale));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  const png = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
  let bin = '';
  for (let i = 0; i < png.length; i += 0x8000) bin += String.fromCharCode.apply(null, png.subarray(i, i + 0x8000));
  return `data:image/png;base64,${btoa(bin)}`;
}

/** A data: URL Returnary can store, from a data: URL or an image address. Throws with the reason. */
async function storableImage(dataUrl, url, fetchImage) {
  let data = dataUrl?.startsWith('data:image/') ? dataUrl : null;
  if (!data && url) data = await fetchImage(url).catch(() => null);
  if (!data) throw new Error(url ? 'the image could not be downloaded from Amazon' : 'no image was saved');
  if (STORABLE.test(data)) return data;
  try {
    return await toPngDataUrl(data);
  } catch (err) {
    throw new Error(`the ${data.slice(5, data.indexOf(';'))} image could not be converted (${err.message})`);
  }
}
const optionalImage = (dataUrl, url, fetchImage) => storableImage(dataUrl, url, fetchImage).catch(() => null);

async function buildPayload(itemKey, rec, domain, fetchImage) {
  const item = rec.item;
  if (!item?.orderId) throw new Error('Item details are missing. Open the dashboard to fill them in.');
  const asin = item.asin || itemKey.split('|')[1] || null;
  const details = rec.orderItems || [];
  const mine = details.find((i) => i.asin === asin);

  const items = await Promise.all(details.slice(0, 20).map(async (i) => ({
    asin: i.asin, name: i.title, price: i.price, quantity: i.quantity,
    photo: await optionalImage(null, i.image, fetchImage),
  })));
  if (!mine) items.push({ asin, name: item.title, price: null, quantity: 1, photo: await optionalImage(null, item.image, fetchImage) });

  let qr = null;
  let qrProblem = null;
  if (rec.qrDataUrl || rec.qrUrl) {
    qr = await storableImage(rec.qrDataUrl, rec.qrUrl, fetchImage).catch((err) => { qrProblem = err.message; return null; });
  } else {
    qrProblem = rec.labelUrl ? 'this is a label return, without a QR code' : 'no QR code was saved for this return';
  }

  const payload = {
    order: {
      orderId: item.orderId,
      orderDate: item.orderTs ? isoDate(new Date(item.orderTs)) : isoFromText(item.orderDate),
      total: money(item.total),
      currency: currencyFor(domain),
      returnBy: isoFromText(item.returnWindow),
    },
    items,
    item: { asin, name: mine?.title || item.title, price: mine?.price ?? null, quantity: mine?.quantity ?? 1 },
    return: { qr, code: rec.code || null },
  };
  return { payload, qrProblem };
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
    let payload, qrProblem;
    try {
      ({ payload, qrProblem } = await buildPayload(key, returns[key], consent.domain, fetchImage));
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
        // Whether the return in Returnary has a QR code now (older Returnary: unknown).
        qrInReturnary: typeof body.has_qr === 'boolean' ? body.has_qr : null,
        qrProblem: body.has_qr ? null : qrProblem || (payload.return.qr ? 'Returnary did not accept the image' : null),
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

// Returns synced before QR codes were checked have no qrInReturnary field:
// queue them once more, so Returnary can add a missing QR code. (Returnary
// only fills in what's missing, so this changes nothing for complete ones.)
export function requeueUncheckedQr() {
  return locked(async () => {
    const { sync = {}, returns = {} } = await chrome.storage.local.get(['sync', 'returns']);
    let changed = 0;
    for (const [key, s] of Object.entries(sync)) {
      const rec = returns[key];
      if (s.status === 'synced' && !('qrInReturnary' in s) && (rec?.qrDataUrl || rec?.qrUrl)) {
        sync[key] = { ...s, status: 'pending', attempts: 0, queuedAt: Date.now() };
        changed++;
      }
    }
    if (changed) await chrome.storage.local.set({ sync });
    return changed;
  });
}
