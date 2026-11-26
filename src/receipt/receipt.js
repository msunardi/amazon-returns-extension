// Printable receipt of every saved return and its QR code.
import { currencyFor } from '../lib/config.js';
import { expectedRefund, refundTotal } from '../lib/refunds.js';

const $ = (sel) => document.querySelector(sel);
let money = (n) => n.toFixed(2);

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'checked') el.checked = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
const safeHttps = (url) => (typeof url === 'string' && url.startsWith('https://') ? url : null);

const excluded = new Set(); // item keys left off the printout

async function load() {
  const { returns = {}, orders = [], consent = {} } = await chrome.storage.local.get(['returns', 'orders', 'consent']);
  const fmt = new Intl.NumberFormat(undefined, { style: 'currency', currency: currencyFor(consent.domain) });
  money = (n) => fmt.format(n);

  // Item details: saved with the return, else from the last scan.
  const fromScan = new Map();
  for (const o of orders) {
    for (const it of o.items) {
      fromScan.set(it.key, { ...it, orderId: o.orderId, orderDate: o.orderDate, orderTs: o.orderTs });
    }
  }
  const lines = Object.entries(returns).map(([key, rec]) => {
    const item = rec.item || fromScan.get(key) || {};
    return { key, rec, title: item.title || `Item ${key.split('|')[1] || ''}`, image: item.image,
      orderId: item.orderId || key.split('|')[0], orderDate: item.orderDate, orderTs: item.orderTs ?? null,
      refund: expectedRefund(key, rec) };
  });

  // Items that Amazon put on one return share the same QR code: print it once.
  const batches = new Map();
  for (const line of lines) {
    const id = line.rec.qrDataUrl || line.rec.qrUrl || line.key;
    if (!batches.has(id)) batches.set(id, { rec: line.rec, lines: [] });
    batches.get(id).lines.push(line);
  }
  // Newest first; returns without a QR code (label returns) go last.
  const sorted = [...batches.values()].sort((a, b) =>
    !(a.rec.qrDataUrl || a.rec.qrUrl) - !(b.rec.qrDataUrl || b.rec.qrUrl) || b.rec.capturedAt - a.rec.capturedAt);
  return { batches: sorted, total: lines.length, returns };
}

function render({ batches, total, returns }) {
  const root = $('#receipt');
  root.replaceChildren();
  const included = total - excluded.size;
  root.append(h('div', { class: 'head' },
    h('h2', {}, 'AMAZON RETURNS'),
    h('p', {}, new Date().toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })),
    h('p', {}, `${included} item${included === 1 ? '' : 's'}`),
    refundLine(returns, batches),
  ));

  if (!total) {
    root.append(h('p', { class: 'empty' }, 'No saved returns yet.'));
  }
  for (const batch of batches) {
    const allOut = batch.lines.every((l) => excluded.has(l.key));
    const { rec } = batch;
    const qrSrc = rec.qrDataUrl || safeHttps(rec.qrUrl);
    root.append(h('section', { class: `batch${allOut ? ' excluded' : ''}` },
      batch.lines.map((line) => h('div', { class: 'line', style: excluded.has(line.key) ? 'display:none' : null },
        h('input', {
          type: 'checkbox', checked: !excluded.has(line.key), title: 'Include on the printout',
          onchange: (e) => { e.target.checked ? excluded.delete(line.key) : excluded.add(line.key); refresh(); },
        }),
        safeHttps(line.image) && h('img', { class: 'thumb', src: line.image, alt: '' }),
        h('div', {},
          h('div', { class: 'title' }, line.title),
          h('div', { class: 'meta' }, [`Order ${line.orderId}`, line.orderDate].filter(Boolean).join(' · ')),
          line.refund && h('div', { class: 'meta' },
            `Expected refund ${line.refund.source === 'price' ? '≈ ' : ''}${money(line.refund.amount)}`),
        ),
      )),
      // Excluded lines are hidden above; list them small so they can be ticked back.
      batch.lines.filter((l) => excluded.has(l.key)).map((line) => h('div', { class: 'line no-print' },
        h('input', { type: 'checkbox', onchange: () => { excluded.delete(line.key); refresh(); } }),
        h('div', { class: 'meta' }, line.title),
      )),
      qrSrc ? h('img', { class: 'qr', src: qrSrc, alt: 'Return QR code' })
        : h('p', { class: 'noqr' }, rec.labelUrl ? 'Label return: print the label from Amazon' : 'No QR code saved'),
      h('div', { class: 'details' },
        rec.code && h('div', {}, 'Return code ', h('strong', {}, rec.code)),
        rec.returnBy && h('div', {}, rec.returnBy),
        rec.location && h('div', {}, rec.location),
        batch.lines.length > 1 && h('div', {}, `One code for these ${batch.lines.length} items`),
      ),
    ));
  }
  root.append(h('p', { class: 'foot' }, 'Show each QR code at the drop-off counter.'));

  $('#count').textContent = total ? `${included} of ${total} item${total === 1 ? '' : 's'} selected` : '';
  $('#printBtn').disabled = included === 0;
}

function refundLine(returns, batches) {
  const keys = batches.flatMap((b) => b.lines.map((l) => l.key)).filter((k) => !excluded.has(k));
  const total = refundTotal(returns, keys);
  if (!keys.length || total.unknown === keys.length) return null;
  const approx = total.estimated || total.unknown ? '≈ ' : '';
  return h('p', { class: 'refund-total' }, `Expected refund ${approx}${money(total.amount)}`);
}

let data;
async function refresh() {
  data ||= await load();
  render(data);
}

$('#printBtn').addEventListener('click', () => window.print());
$('#allBtn').addEventListener('click', () => { excluded.clear(); refresh(); });
$('#noneBtn').addEventListener('click', () => {
  data.batches.forEach((b) => b.lines.forEach((l) => excluded.add(l.key)));
  refresh();
});
$('#photosToggle').addEventListener('change', (e) => $('#receipt').classList.toggle('hide-photos', !e.target.checked));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.returns) { data = null; refresh(); }
});
refresh();
