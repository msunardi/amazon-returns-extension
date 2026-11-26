// Parses Amazon's order-history HTML into plain objects.
//
// Amazon has no public API for this and changes its markup from time to time.
// Every selector and pattern lives in SELECTORS and PATTERNS below, so when a
// scan stops finding orders, those two objects are the place to fix it.

export const SELECTORS = {
  orderCard: '.order-card, .js-order-card, .a-box-group.order',
  shipment: '.shipment, .delivery-box, .a-box.shipment, [class*="shipment"]',
  shipmentStatus: [
    '.delivery-box__primary-text',
    '.yohtmlc-shipment-status-primaryText',
    '.js-shipment-info-container .a-text-bold',
    '.shipment-top-row .a-text-bold',
  ].join(', '),
  nextPage: '.a-pagination .a-last:not(.a-disabled) a',
  signInForm: 'form[name="signIn"], #ap_email, #ap_password',
  captchaForm: 'form[action*="validateCaptcha"]',
};

export const PATTERNS = {
  orderId: /\b(\d{3}-\d{7}-\d{7}|D\d{2}-\d{7}-\d{7})\b/,
  orderDate: /Order placed\s*([A-Za-z]+\.?\s+\d{1,2},?\s+\d{4}|\d{1,2}\s+[A-Za-z]+\.?\s+\d{4})/i,
  total: /Total\s*([^\d\s]{0,4}\s?\d[\d.,]*)/,
  asin: /\/(?:dp|gp\/product)\/([A-Z0-9]{10})/,
  returnHref: /\/(?:spr\/returns|returns\/|gp\/orc\/returns)/i,
  returnText: /Return or replace items|Return items|Return or replace/i,
  returnWindow:
    /Return(?: or replace items:)?\s*(?:items:\s*)?(?:Eligible through|window closed on)\s+([A-Za-z]+\.?\s+\d{1,2},?\s+\d{4}|\d{1,2}\s+[A-Za-z]+\.?\s+\d{4})/i,
  status:
    /\b(Delivered|Now arriving|Arriving|Out for delivery|Shipped|Not yet shipped|Return started|Return complete|Return received|Refund issued|Refunded)\b[^|]{0,30}/i,
  // Link texts that point at the product but are not its title.
  notATitle: /^(Buy it again|View your item|Write a product review|Track package|Get product support|Leave seller feedback|Ask Product Question)$/i,
};

const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

function absolute(href, base) {
  try {
    const url = new URL(href, base);
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} html     the page's HTML
 * @param {string} finalUrl the URL after redirects
 * @param {string} base     the storefront, e.g. https://www.amazon.com
 */
export function parseOrdersPage(html, finalUrl, base) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const result = { orders: [], hasNext: false, signedOut: false, blocked: false };

  if (/\/ap\/signin/.test(finalUrl) || doc.querySelector(SELECTORS.signInForm)) {
    result.signedOut = true;
    return result;
  }
  if (/validateCaptcha/.test(finalUrl) || doc.querySelector(SELECTORS.captchaForm)) {
    result.blocked = true;
    return result;
  }

  let cards = [...doc.querySelectorAll(SELECTORS.orderCard)];
  // Several card selectors can match nested elements of one card: keep the outermost.
  cards = cards.filter((c) => !cards.some((o) => o !== c && o.contains(c)));
  const cardsBySelector = cards.length;
  let usedFallback = false;
  if (!cards.length) {
    cards = findCardsByOrderId(doc);
    usedFallback = cards.length > 0;
  }

  for (const card of cards) {
    const order = parseCard(card, base);
    if (order) result.orders.push(order);
  }
  result.hasNext = !!doc.querySelector(SELECTORS.nextPage);
  result.diagnostics = {
    title: clean(doc.title),
    htmlLength: html.length,
    orderIdsInPage: new Set(html.match(new RegExp(PATTERNS.orderId.source, 'g')) || []).size,
    productLinks: doc.querySelectorAll('a[href*="/dp/"], a[href*="/gp/product/"]').length,
    cardsBySelector,
    usedFallback,
  };
  return result;
}

// Fallback when no card selector matches: start from each order number in the
// page text and climb to the largest ancestor that still holds only that one
// order number and contains a product link.
function findCardsByOrderId(doc) {
  const SHOW_TEXT = 4; // NodeFilter.SHOW_TEXT
  const idsRe = new RegExp(PATTERNS.orderId.source, 'g');
  const walker = doc.createTreeWalker(doc.body, SHOW_TEXT);
  const seen = new Set();
  const cards = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const id = node.nodeValue.match(PATTERNS.orderId)?.[1];
    if (!id || seen.has(id)) continue;
    let best = null;
    for (let el = node.parentElement; el && el !== doc.body; el = el.parentElement) {
      if (new Set(el.textContent.match(idsRe)).size > 1) break;
      if (el.querySelector('a[href*="/dp/"], a[href*="/gp/product/"]')) best = el;
    }
    if (best) {
      seen.add(id);
      cards.push(best);
    }
  }
  return cards;
}

function findReturnLink(root, base) {
  const link = [...root.querySelectorAll('a[href]')].find(
    (a) =>
      PATTERNS.returnHref.test(a.getAttribute('href')) ||
      PATTERNS.returnText.test(clean(a.textContent)),
  );
  return link ? absolute(link.getAttribute('href'), base) : null;
}

function parseCard(card, base) {
  const text = clean(card.textContent);
  const idMatch = text.match(PATTERNS.orderId);
  if (!idMatch) return null;
  const orderId = idMatch[1];

  const dateMatch = text.match(PATTERNS.orderDate);
  const orderDate = dateMatch ? dateMatch[1] : null;
  const orderTs = orderDate ? Date.parse(orderDate.replace('.', '')) : NaN;
  const total = text.match(PATTERNS.total)?.[1] ?? null;
  const orderReturnUrl = findReturnLink(card, base);

  const items = new Map();
  for (const link of card.querySelectorAll('a[href]')) {
    const href = link.getAttribute('href');
    const asin = href.match(PATTERNS.asin)?.[1];
    if (!asin) continue;

    let item = items.get(asin);
    if (!item) {
      const shipment = link.closest(SELECTORS.shipment) || card;
      const shipText = clean(shipment.textContent);
      const statusEl = shipment.querySelector(SELECTORS.shipmentStatus);
      item = {
        key: `${orderId}|${asin}`,
        asin,
        title: '',
        url: absolute(href, base),
        image: null,
        status: clean(statusEl?.textContent) || shipText.match(PATTERNS.status)?.[0]?.trim() || '',
        returnWindow: shipText.match(PATTERNS.returnWindow)?.[0] ?? '',
        returnUrl: shipment !== card ? findReturnLink(shipment, base) : null,
      };
      items.set(asin, item);
    }

    const linkText = clean(link.textContent);
    if (linkText && !PATTERNS.notATitle.test(linkText) && linkText.length > item.title.length) {
      item.title = linkText;
      item.url = absolute(href, base);
    }
    const img = link.querySelector('img');
    if (img) {
      item.image ||= absolute(img.getAttribute('src') || img.getAttribute('data-src') || '', base);
      if (!item.title) item.title = clean(img.getAttribute('alt'));
    }
  }

  const fallbackReturnUrl = `${base}/spr/returns/cart?orderId=${encodeURIComponent(orderId)}`;
  return {
    orderId,
    orderDate,
    orderTs: Number.isNaN(orderTs) ? null : orderTs,
    total,
    detailsUrl: `${base}/gp/your-account/order-details?orderID=${encodeURIComponent(orderId)}`,
    items: [...items.values()].map((it) => ({
      ...it,
      title: it.title || `Item ${it.asin}`,
      returnUrl: it.returnUrl || orderReturnUrl || fallbackReturnUrl,
      returnUrlGuessed: !it.returnUrl && !orderReturnUrl,
    })),
  };
}

// ---- order details page: per-item prices and quantities ---------------------
const PRICE = /(?:US\$|CDN\$|C\$|\$|£|€)\s?(\d{1,3}(?:,\d{3})*\.\d{2}|\d+\.\d{2})/;
const QTY = /\b(?:Qty|Quantity)\s*:?\s*(\d{1,3})\b/i;
const SUMMARY = /Item\(s\) Subtotal|Order Summary|Grand Total/i;

export function parseOrderDetails(html, finalUrl, base) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  if (/\/ap\/signin/.test(finalUrl) || doc.querySelector(SELECTORS.signInForm)) return { signedOut: true, items: [] };

  const asinsIn = (el) => new Set([...el.querySelectorAll('a[href]')]
    .map((a) => a.getAttribute('href').match(PATTERNS.asin)?.[1]).filter(Boolean));
  const items = [];
  const seen = new Set();
  for (const link of doc.querySelectorAll('a[href]')) {
    const asin = link.getAttribute('href').match(PATTERNS.asin)?.[1];
    if (!asin || seen.has(asin)) continue;
    seen.add(asin);

    // The item's block: the largest ancestor that holds only this item and
    // not the order summary.
    let box = link;
    for (let depth = 0; depth < 10 && box.parentElement && box.parentElement !== doc.body; depth++) {
      const parent = box.parentElement;
      if (asinsIn(parent).size > 1 || SUMMARY.test(parent.textContent)) break;
      box = parent;
    }
    const text = clean(box.textContent);
    const titles = [...box.querySelectorAll('a[href]')]
      .filter((a) => a.getAttribute('href').includes(asin))
      .map((a) => clean(a.textContent))
      .filter((t) => t && !PATTERNS.notATitle.test(t));
    const qtyEl = box.querySelector('.od-item-view-qty, .item-view-qty, .product-image__qty');
    const img = box.querySelector('img');
    items.push({
      asin,
      title: titles.sort((a, b) => b.length - a.length)[0] || clean(img?.getAttribute('alt')) || '',
      price: Number((text.match(PRICE)?.[1] || '').replace(/,/g, '')) || null,
      quantity: Number(clean(qtyEl?.textContent).match(/\d+/)?.[0] || text.match(QTY)?.[1]) || 1,
      image: img ? absolute(img.getAttribute('src') || '', base) : null,
    });
  }
  return { signedOut: false, items: items.filter((i) => i.title) };
}
