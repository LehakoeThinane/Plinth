import { escapeText as e,formatRand } from './storefront.js';
const statuses={pending:'Waiting for payment confirmation',paid:'Paid',failed:'Payment failed',review:'Under review',refunded:'Refunded'};
/** The stand-in provider's hosted page: obviously not a real payment screen. */
export function renderTestPayment(session) {
  const ref=encodeURIComponent(session.reference);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Test payment</title>
<style>body{font-family:system-ui,sans-serif;max-width:520px;margin:40px auto;padding:0 16px;color:#172334}.banner{background:#7a1f1f;color:white;padding:12px 16px;border-radius:8px;font-weight:700}
form{display:inline-block;margin-right:12px}button{font:inherit;padding:10px 18px;border-radius:6px;border:0;cursor:pointer}.approve{background:#1f6f3a;color:white}.decline{background:#ddd}</style></head>
<body><p class="banner">TEST MODE: no real money moves. This page stands in for the payment provider.</p>
<h1>${e(session.description??'Order')}</h1><p>Amount: <strong>${e(formatRand(session.amountCents))}</strong></p>
<form method="post" action="/test-payments/${ref}/approve"><button class="approve">Approve test payment</button></form>
<form method="post" action="/test-payments/${ref}/decline"><button class="decline">Decline</button></form></body></html>`;
}
export function renderCheckout({hub,product,plan}) {
  return `<p><a href="/h/${e(hub.slug)}/products/${e(product.id)}">Back to ${e(product.title)}</a></p><h1>Buy ${e(product.title)}</h1>
    <p>Price: <strong>${e(formatRand(plan.amount_cents))}</strong>, once-off.</p>
    <p>You will be sent to the payment provider. Access starts when the provider confirms payment.</p>
    <button type="button" id="start-checkout" data-plan-id="${e(plan.id)}">Continue to payment</button>`;
}
export function renderOrders({hub,orders}) {
  const rows=orders.map(o=>`<tr><td><a href="/h/${e(hub.slug)}/orders/${e(o.id)}">${e(o.title)}</a></td><td>${e(formatRand(o.total_cents))}</td><td>${e(statuses[o.status]??o.status)}</td><td>${e(o.created_at)}</td></tr>`).join('');
  return `<h1>Your orders</h1>${rows?`<table><thead><tr><th>Product</th><th>Total</th><th>Status</th><th>Placed</th></tr></thead><tbody>${rows}</tbody></table>`:'<p>No orders yet.</p>'}`;
}
export function renderOrder({hub,order}) {
  const next=order.status==='paid'?`<p><a href="/h/${e(hub.slug)}/learning">Start learning</a></p>`:
    order.status==='pending'?'<p>We are waiting for the payment provider to confirm. Refresh this page in a moment.</p>':
    order.status==='failed'?`<p><a href="/h/${e(hub.slug)}/products/${e(order.product_id)}">Try again</a></p>`:'<p>The provider will review this order.</p>';
  return `<p><a href="/h/${e(hub.slug)}/orders">All orders</a></p><h1>${e(order.title)}</h1>
    <p>Status: <strong>${e(statuses[order.status]??order.status)}</strong></p><p>Total: ${e(formatRand(order.total_cents))} (VAT ${e(formatRand(order.vat_cents))})</p>${next}`;
}
const accounts={buyer_payment:'Buyer payments',provider_revenue:'Your revenue',vat_payable:'VAT payable',payment_fees:'Payment fees'};
export function renderSales({hub,sales}) {
  const ledger=sales.ledger.map(l=>`<tr><td>${e(accounts[l.account]??l.account)}</td><td>${e(formatRand(l.debit_cents))}</td><td>${e(formatRand(l.credit_cents))}</td></tr>`).join('');
  const orders=sales.orders.map(o=>`<tr><td>${e(o.title)}</td><td>${e(formatRand(o.total_cents))}</td><td>${e(statuses[o.status]??o.status)}</td><td><code>${e(o.buyer_id)}</code></td><td>${e(o.created_at)}</td>
    <td>${o.status==='paid'?`<button type="button" class="refund-order" data-order-id="${e(o.id)}">Refund</button>`:''}</td></tr>`).join('');
  return `<h1>Sales</h1><section><h2>Ledger</h2><p>Double-entry totals. Entries are never edited; corrections are reversing entries.</p>
    ${ledger?`<table><thead><tr><th>Account</th><th>Debits</th><th>Credits</th></tr></thead><tbody>${ledger}</tbody></table>`:'<p>No sales yet.</p>'}</section>
    <section><h2>Orders</h2>${orders?`<table><thead><tr><th>Product</th><th>Total</th><th>Status</th><th>Buyer</th><th>Placed</th><th></th></tr></thead><tbody>${orders}</tbody></table>`:'<p>No orders yet.</p>'}</section>`;
}
