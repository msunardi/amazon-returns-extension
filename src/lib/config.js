// Shared settings for the dashboard and the service worker.

// Only English-language storefronts: the parser matches English labels
// such as "Order placed" and "Total".
export const MARKETPLACES = {
  'amazon.com': { label: 'Amazon.com (US)', base: 'https://www.amazon.com' },
  'amazon.ca': { label: 'Amazon.ca (Canada)', base: 'https://www.amazon.ca' },
  'amazon.co.uk': { label: 'Amazon.co.uk (UK)', base: 'https://www.amazon.co.uk' },
};

export const DEFAULT_MARKETPLACE = 'amazon.com';

// The order-history page. Amazon also serves the older
// /gp/your-account/order-history path, which redirects here.
export const ORDERS_PATH = '/your-orders/orders';
export const ORDERS_TIME_FILTER = 'last30';
export const ORDERS_PAGE_SIZE = 10;
export const MAX_PAGES = 5;
export const DAYS = 30;

// The origins we ask the user for. Product and QR images are served from
// Amazon's image CDNs, so we ask for those as well.
export function originsFor(domain) {
  return [
    `https://*.${domain}/*`,
    'https://*.media-amazon.com/*',
    'https://*.ssl-images-amazon.com/*',
  ];
}

export function isMarketplaceUrl(url) {
  try {
    const { protocol, hostname } = new URL(url);
    if (protocol !== 'https:') return false;
    return Object.keys(MARKETPLACES).some(
      (d) => hostname === d || hostname.endsWith(`.${d}`),
    );
  } catch {
    return false;
  }
}

// ---- Returnary (the local purchase tracker) ---------------------------------
export const RETURNARY_DEFAULT_URL = 'http://127.0.0.1:5000';
export const RETURNARY_CLIENT = 'amazon-return-manager'; // sent as X-Returnary-Client
export const SYNC_EVERY_MINUTES = 5;

const CURRENCY = { 'amazon.com': 'USD', 'amazon.ca': 'CAD', 'amazon.co.uk': 'GBP' };
export const currencyFor = (domain) => CURRENCY[domain] || 'USD';

// Returnary runs on this computer; returns are only ever sent to a local address.
export function returnaryOrigin(url) {
  try {
    const u = new URL(url);
    // Must match optional_host_permissions in manifest.json.
    if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(u.hostname)) return null;
    return { base: u.origin, pattern: `${u.protocol}//${u.hostname}/*` };
  } catch {
    return null;
  }
}
