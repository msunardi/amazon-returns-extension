// Injected only into return windows the dashboard opened. It shows a small
// bar in the corner, watches the Amazon return flow and, once the
// confirmation page shows a QR code (or a return label), sends it to the
// service worker. If automatic detection misses, the user can click
// "Pick QR code" and then click the QR code on the page.
//
// Amazon's markup is undocumented: the patterns below are best guesses and
// are the place to fix automatic capture when Amazon changes its pages.
(() => {
  if (window.__armReturnWatcher) return;
  window.__armReturnWatcher = true;

  const QR_HINT = /(^|[^a-z])qr([^a-z]|$)|qr[-_ ]?code|qrcode/i;
  const CONFIRMED_TEXT = new RegExp([
    'return (?:is |has been )?(?:confirmed|created|started|submitted)',
    'your return is (?:confirmed|ready|on its way)',
    "we(?:'ve| have) (?:emailed|sent)[^.]{0,40}(?:qr|label|return)",
    '(?:show|scan|bring|present) (?:this|the|your) qr code',
    'drop (?:it |them )?off by',
  ].join('|'), 'i');
  const CODE_TEXT = /(?:return|drop[- ]?off|authori[sz]ation|rma)\s*code\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{3,})/i;
  const RETURN_BY_TEXT =
    /(?:return|drop[- ]?off|ship)\s+(?:it\s+)?by\s+((?:[A-Za-z]+,?\s+)?[A-Za-z]+\.?\s+\d{1,2}(?:,\s*\d{4})?|\d{1,2}\s+[A-Za-z]+(?:\s+\d{4})?)/i;
  const LOCATION_TEXT =
    /[^.\n]*(UPS Store|The UPS Store|Whole Foods|Kohl'?s|Amazon Fresh|Staples|Amazon Locker|Amazon Hub|Counter|Post Office|Canada Post|Royal Mail|Evri|InPost)[^.\n]*/i;
  const MEDIA = 'img, canvas, svg';
  // The refund Amazon expects to give, e.g. "Estimated refund $24.99" or
  // "Refund total: $24.99". The amount may be on the next line.
  const MONEY = String.raw`(?:US\$|CDN\$|C\$|\$|£|€)\s?(\d{1,3}(?:,\d{3})*\.\d{2}|\d+\.\d{2})`;
  const REFUND_TEXT = [
    new RegExp(String.raw`(?:total\s+)?(?:estimated|expected)\s+refund(?:\s+(?:amount|total|subtotal))?\s*(?:is|of|:)?\s*` + MONEY, 'i'),
    new RegExp(String.raw`refund\s+(?:amount|total|subtotal)\s*(?:is|of|:)?\s*` + MONEY, 'i'),
    new RegExp(String.raw`(?:receive|get|issue)\s+(?:a|your)\s+refund\s+of\s*` + MONEY, 'i'),
  ];

  let autoDone = false;      // automatic detection finished (or user picked)
  let confirmedSince = 0;
  let lastSnapshot = '';

  // ---- helpers ---------------------------------------------------------------
  const pageText = () => document.body?.innerText || '';
  const stripQuery = (u) => {
    try { const x = new URL(u, location.href); return x.protocol === 'data:' ? 'data:…' : x.origin + x.pathname; }
    catch { return String(u).slice(0, 100); }
  };
  const log = (event, data = {}) =>
    chrome.runtime.sendMessage({ type: 'watcher-log', event, data }).catch(() => {});

  function box(el) {
    const r = el.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) };
  }
  function isSquareAndBig(el, min = 100) {
    const { w, h } = box(el);
    return w >= min && h >= min && w / h > 0.8 && w / h < 1.25;
  }
  function hintText(el) {
    const parts = [];
    for (let node = el, depth = 0; node && depth < 4; depth++, node = node.parentElement) {
      const cls = typeof node.className === 'string' ? node.className : node.className?.baseVal;
      parts.push(node.id, cls, node.getAttribute?.('data-testid'), node.getAttribute?.('aria-label'));
    }
    parts.push(el.getAttribute('alt'), el.getAttribute('src'), el.getAttribute('title'));
    return parts.filter(Boolean).join(' ');
  }
  function bgImageUrl(el) {
    return getComputedStyle(el).backgroundImage.match(/url\(["']?(.*?)["']?\)/)?.[1] || null;
  }

  // ---- automatic detection ---------------------------------------------------
  function findQrElement() {
    const candidates = [...document.querySelectorAll(MEDIA)].filter((el) => isSquareAndBig(el));
    const hinted = candidates.find((el) => QR_HINT.test(hintText(el)));
    if (hinted) return hinted;

    // No element names itself a QR code: on a confirmation page that talks
    // about one, take the largest square image that is not a product photo.
    const text = pageText();
    if (!/QR code/i.test(text) || !CONFIRMED_TEXT.test(text)) return null;
    const nonProduct = candidates.filter(
      (el) => !(el.tagName === 'IMG' && /\/images\/I\//.test(el.getAttribute('src') || '')),
    );
    nonProduct.sort((a, b) => box(b).w - box(a).w);
    return nonProduct[0] || null;
  }

  async function captureElement(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'canvas') {
      try { return { qrDataUrl: el.toDataURL('image/png') }; } catch { return {}; }
    }
    if (tag === 'svg' || el instanceof SVGElement) {
      const svg = el.ownerSVGElement || el;
      const xml = new XMLSerializer().serializeToString(svg);
      const svgUrl = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(xml)))}`;
      // Turn it into a PNG, which Returnary (and printers) handle everywhere.
      try {
        const { w, h } = box(svg);
        const img = new Image();
        await new Promise((ok, fail) => { img.onload = ok; img.onerror = fail; img.src = svgUrl; setTimeout(fail, 3000); });
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, w) * 2;
        canvas.height = Math.max(1, h) * 2;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        return { qrDataUrl: canvas.toDataURL('image/png') };
      } catch {
        return { qrDataUrl: svgUrl };
      }
    }
    if (tag === 'img') {
      const src = el.currentSrc || el.src;
      if (src.startsWith('data:')) return { qrDataUrl: src };
      if (!el.complete) {
        // Wait for the image, but never forever (lazy images may not load).
        await new Promise((r) => {
          el.addEventListener('load', r, { once: true });
          el.addEventListener('error', r, { once: true });
          setTimeout(r, 3000);
        });
      }
      if (!el.naturalWidth) return { qrUrl: src };
      try {
        const canvas = document.createElement('canvas');
        canvas.width = el.naturalWidth;
        canvas.height = el.naturalHeight;
        canvas.getContext('2d').drawImage(el, 0, 0);
        return { qrDataUrl: canvas.toDataURL('image/png'), qrUrl: src };
      } catch {
        return { qrUrl: src }; // cross-origin image: the service worker fetches it
      }
    }
    const bg = bgImageUrl(el); // QR drawn as a CSS background
    if (bg) return bg.startsWith('data:') ? { qrDataUrl: bg } : { qrUrl: new URL(bg, location.href).href };
    return {};
  }

  function readRefund() {
    const text = pageText();
    for (const re of REFUND_TEXT) {
      const m = text.match(re);
      const amount = m ? Number(m[1].replace(/,/g, '')) : NaN;
      if (amount >= 0 && amount < 100000) return { amount, text: m[0].replace(/\s+/g, ' ').trim().slice(0, 120) };
    }
    return null;
  }

  // Tell the service worker about every refund amount seen on the way, so
  // the one shown before confirming is kept even if the confirmation page
  // doesn't repeat it.
  let lastRefund = '';
  function reportRefund() {
    const refund = readRefund();
    const key = refund ? String(refund.amount) : '';
    if (!refund || key === lastRefund) return;
    lastRefund = key;
    log('refund', refund);
    chrome.runtime.sendMessage({ type: 'refund-seen', refund }).catch(() => {});
  }

  function readDetails() {
    const text = pageText();
    const labelLink = [...document.querySelectorAll('a[href]')].find(
      (a) => /print.*label|label.*print|download.*label/i.test(a.textContent) || /\/label/i.test(a.href),
    );
    return {
      code: text.match(CODE_TEXT)?.[1] ?? null,
      returnBy: text.match(RETURN_BY_TEXT)?.[0]?.trim() ?? null,
      location: text.match(LOCATION_TEXT)?.[0]?.trim().slice(0, 160) ?? null,
      labelUrl: labelLink?.href?.startsWith('https://') ? labelLink.href : null,
      pageUrl: location.href,
      refund: readRefund(),
    };
  }

  // What the watcher sees, for the dashboard's troubleshooting log. Image
  // addresses are logged without their query strings.
  function snapshot() {
    const text = pageText();
    return {
      url: stripQuery(location.href),
      mentionsQrCode: /QR code/i.test(text),
      confirmedText: text.match(CONFIRMED_TEXT)?.[0] ?? null,
      iframes: document.querySelectorAll('iframe').length,
      refundText: readRefund()?.text ?? null,
      images: [...document.querySelectorAll(MEDIA)]
        .map((el) => ({ el, ...box(el) }))
        .filter((c) => c.w >= 60 && c.h >= 60)
        .slice(0, 12)
        .map(({ el, w, h }) => {
          const hint = hintText(el).replace(/\s+/g, ' ').slice(0, 70);
          const src = el.getAttribute('src');
          return `${el.tagName.toLowerCase()} ${w}x${h}${src ? ` ${stripQuery(src)}` : ''}${hint ? ` [${hint}]` : ''}`;
        }),
    };
  }

  async function save(payload, how) {
    log('capture', { how, hasImageData: !!payload.qrDataUrl, qrUrl: payload.qrUrl ? stripQuery(payload.qrUrl) : null });
    try {
      const res = await chrome.runtime.sendMessage({ type: 'qr-captured', payload });
      if (res?.ok) setBar('ok', res.hasImage
        ? 'QR code saved to your dashboard. You can close this window.'
        : 'Return saved to your dashboard, but without the QR image. Try "Pick a different QR code".',
      'Pick a different QR code');
      else setBar('err', `Could not save: ${res?.error || 'unknown error'}`, 'Pick QR code');
    } catch (err) {
      setBar('err', `Could not save: ${err.message}`, 'Pick QR code');
    }
  }

  async function check() {
    if (autoDone) return;
    const snap = JSON.stringify(snapshot());
    if (snap !== lastSnapshot) { lastSnapshot = snap; log('page', JSON.parse(snap)); }

    const qr = findQrElement();
    if (qr) {
      autoDone = true;
      observer.disconnect();
      await save({ ...(await captureElement(qr)), ...readDetails() }, 'auto');
      return;
    }

    const text = pageText();
    if (!CONFIRMED_TEXT.test(text)) return;
    confirmedSince ||= Date.now();
    if (Date.now() - confirmedSince < 4000) { setTimeout(check, 1000); return; }

    if (/QR code/i.test(text)) {
      // The page talks about a QR code we could not find: ask the user.
      autoDone = true;
      log('not-found', {});
      setBar('pick', "Couldn't find the QR code automatically. Click the button, then click the QR code.", 'Pick QR code');
    } else {
      // A label-only return: save what the page has.
      autoDone = true;
      observer.disconnect();
      await save(readDetails(), 'auto-label');
    }
  }

  // ---- the bar in the corner -------------------------------------------------
  const host = document.createElement('div');
  const shadow = host.attachShadow({ mode: 'closed' });
  shadow.innerHTML = `<style>
    .bar{position:fixed;right:16px;bottom:16px;z-index:2147483647;display:flex;gap:10px;align-items:center;
      max-width:440px;padding:10px 12px;border-radius:10px;font:13px/1.4 system-ui,sans-serif;color:#fff;
      background:#1f2937;box-shadow:0 4px 16px rgba(0,0,0,.3)}
    .bar.ok{background:#15803d}.bar.err{background:#b91c1c}.bar.pick{background:#c2570c}
    button{font:inherit;font-weight:600;border:0;border-radius:6px;padding:6px 10px;cursor:pointer;background:#fff;color:#111;white-space:nowrap}
  </style><div class="bar"><span class="msg"></span><button type="button"></button></div>`;
  const bar = shadow.querySelector('.bar');
  const msg = shadow.querySelector('.msg');
  const btn = shadow.querySelector('button');
  function setBar(kind, text, buttonLabel) {
    bar.className = `bar ${kind}`;
    msg.textContent = text;
    btn.textContent = buttonLabel;
  }
  btn.addEventListener('click', () => (picking ? stopPicking(true) : startPicking()));
  document.documentElement.appendChild(host);

  // ---- manual pick mode ------------------------------------------------------
  let picking = false;
  let hovered = null;
  let barBeforePick = null;

  function pickTarget(t) {
    if (!(t instanceof Element) || t === host) return null;
    const media = t.closest(MEDIA);
    if (media) return media;
    if (bgImageUrl(t)) return t;
    const inner = [...t.querySelectorAll(MEDIA)].filter((el) => isSquareAndBig(el, 60));
    return inner.length === 1 ? inner[0] : null;
  }
  function highlight(el) {
    if (hovered === el) return;
    if (hovered) { hovered.style.outline = hovered.__armOutline; }
    hovered = el;
    if (el) { el.__armOutline = el.style.outline; el.style.outline = '4px solid #f97316'; }
  }
  const onMove = (e) => highlight(pickTarget(e.target));
  const onKey = (e) => { if (e.key === 'Escape') stopPicking(true); };
  async function onClick(e) {
    if (e.target === host) return;
    const el = pickTarget(e.target);
    e.preventDefault();
    e.stopPropagation();
    if (!el) return;
    stopPicking(false);
    autoDone = true;
    observer.disconnect();
    const image = await captureElement(el);
    if (!image.qrDataUrl && !image.qrUrl) {
      setBar('err', 'Could not read that element. Click directly on the QR code.', 'Pick QR code');
      return;
    }
    await save({ ...image, ...readDetails() }, 'manual');
  }
  function startPicking() {
    picking = true;
    barBeforePick = [bar.className.replace('bar', '').trim(), msg.textContent, btn.textContent];
    setBar('pick', 'Click the QR code on the page. Press Esc to cancel.', 'Cancel');
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
  }
  function stopPicking(restoreBar) {
    picking = false;
    highlight(null);
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKey, true);
    if (restoreBar && barBeforePick) setBar(...barBeforePick);
  }

  // ---- start -----------------------------------------------------------------
  let timer;
  const observer = new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(check, 500);
  });
  // Refund amounts are watched for even after the QR code is saved.
  let refundTimer;
  new MutationObserver(() => {
    clearTimeout(refundTimer);
    refundTimer = setTimeout(reportRefund, 500);
  }).observe(document.documentElement, { childList: true, subtree: true });
  reportRefund();

  (async () => {
    const status = await chrome.runtime.sendMessage({ type: 'watcher-status' }).catch(() => null);
    log('injected', { url: stripQuery(location.href), alreadySaved: !!status?.captured });
    if (status?.captured) {
      autoDone = true;
      setBar('ok', 'QR code already saved to your dashboard. You can close this window.', 'Pick a different QR code');
      return;
    }
    setBar('', 'Return Manager is watching for the QR code…', 'Pick QR code manually');
    observer.observe(document.documentElement, { childList: true, subtree: true });
    check();
  })();
})();
