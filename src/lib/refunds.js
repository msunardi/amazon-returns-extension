// Expected refunds for saved returns, shared by the dashboard and the receipt.

/**
 * The refund expected for one saved return:
 *   { amount, source: 'amazon', text }  the amount Amazon showed in the return flow
 *   { amount, source: 'price' }         no amount was seen: the item's price x quantity,
 *                                       from the order details page
 *   null                                neither is known
 */
export function expectedRefund(key, rec) {
  if (!rec) return null;
  if (typeof rec.refund?.amount === 'number') {
    return { amount: rec.refund.amount, source: 'amazon', text: rec.refund.text || '' };
  }
  const asin = rec.item?.asin || key.split('|')[1];
  const item = (rec.orderItems || []).find((i) => i.asin === asin);
  if (typeof item?.price === 'number') {
    return { amount: Math.round(item.price * (item.quantity || 1) * 100) / 100, source: 'price' };
  }
  return null;
}

/** Sum over saved returns (optionally only the given keys). */
export function refundTotal(returns, keys = Object.keys(returns)) {
  let amount = 0;
  let estimated = 0;
  let unknown = 0;
  for (const key of keys) {
    const refund = expectedRefund(key, returns[key]);
    if (!refund) unknown++;
    else {
      amount += refund.amount;
      if (refund.source === 'price') estimated++;
    }
  }
  return { amount: Math.round(amount * 100) / 100, count: keys.length, estimated, unknown };
}
