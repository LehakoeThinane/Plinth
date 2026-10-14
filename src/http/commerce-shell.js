import { escapeText as e,formatRand } from './storefront.js';
import { head,when,badge } from './ui.js';
const statuses={pending:'Waiting for payment confirmation',paid:'Paid',failed:'Payment failed',review:'Under review',refunded:'Refunded'};
const standIn=(title,banner,body)=>`${head({title})}<body><div class="testmode"><div class="wrap">${banner}</div></div>
<main id="main" class="standin">${body}</main></body></html>`;
/** The stand-in provider's hosted page: obviously not a real payment screen. */
export function renderTestPayment(session) {
  const ref=encodeURIComponent(session.reference);
  return standIn('Test payment','TEST MODE: no real money moves. This page stands in for the payment provider.',
    `<p class="eyebrow">Payment</p><h1>${e(session.description??'Order')}</h1>
<section class="panel"><dl class="facts"><dt>Amount</dt><dd class="price">${e(formatRand(session.amountCents))}</dd><dt>Card</dt><dd>None needed in test mode</dd></dl>
<div class="actions"><form method="post" action="/test-payments/${ref}/approve"><button class="approve">Approve test payment</button></form>
<form method="post" action="/test-payments/${ref}/decline"><button type="submit" class="decline">Decline</button></form></div></section>`);
}
const per=interval=>interval==='year'?'per year':'per month';
/** Seats are bought by a company admin for one of their organisations. */
function renderSeatCheckout({hub,product,plan,companies}) {
  const back=`<p class="crumb"><a href="/h/${e(hub.slug)}/products/${e(product.id)}">Back to ${e(product.title)}</a></p><h1>Buy seats for ${e(product.title)}</h1>`;
  if(!companies.length)return back+`<section><p>Seats are bought by a company administrator for their organisation.</p>
    <p class="muted">Set up your company on the <a href="/h/${e(hub.slug)}/organisations">Organisations</a> page first, or ask your company's administrator to buy the seats.</p></section>`;
  return back+`<section><h2>Order</h2>
    <label>Organisation<select id="seat-org">${companies.map(c=>`<option value="${e(c.id)}">${e(c.display_name)}</option>`).join('')}</select></label>
    <label>Number of seats<input id="seat-quantity" type="number" min="1" max="1000" value="10" required></label>
    <dl class="facts"><dt>Price per seat</dt><dd class="price">${e(formatRand(plan.amount_cents))}</dd><dt>Total</dt><dd class="price" id="seat-total" data-unit="${e(plan.amount_cents)}">${e(formatRand(plan.amount_cents*10))}</dd></dl>
    <p class="muted">The seats belong to the organisation. After payment, assign them to colleagues on the Company seats page. Each seat gives one person access.</p>
    <p class="actions"><button type="button" id="start-checkout" data-plan-id="${e(plan.id)}">Continue to payment</button></p></section>`;
}
export function renderCheckout({hub,product,plan,companies=[]}) {
  if(plan.model==='per_seat')return renderSeatCheckout({hub,product,plan,companies});
  const subscription=plan.model==='subscription';
  return `<p class="crumb"><a href="/h/${e(hub.slug)}/products/${e(product.id)}">Back to ${e(product.title)}</a></p><h1>${subscription?'Subscribe to':'Buy'} ${e(product.title)}</h1>
    <section><h2>Order summary</h2><dl class="facts"><dt>Product</dt><dd>${e(product.title)}</dd><dt>Price</dt><dd class="price">${e(formatRand(plan.amount_cents))}${subscription?' '+per(plan.billing_interval):''}</dd>
    <dt>Billing</dt><dd>${subscription?'Renews until you cancel':'Once-off'}</dd></dl>
    <p class="muted">You will be sent to the payment provider. Access starts when the provider confirms payment.</p>
    <p class="actions">${subscription?`<button type="button" id="start-subscription" data-plan-id="${e(plan.id)}">Continue to payment</button>`:
      `<button type="button" id="start-checkout" data-plan-id="${e(plan.id)}">Continue to payment</button>`}</p></section>`;
}
export function renderSubscribe({hub,tier}) {
  return `<p class="crumb"><a href="/h/${e(hub.slug)}/membership">All tiers</a></p><h1>Join ${e(tier.name)}</h1><p class="lede">${e(tier.description)}</p>
    <section><h2>Subscription</h2><dl class="facts"><dt>Price</dt><dd class="price">${e(formatRand(tier.amount_cents))} ${per(tier.billing_interval)}</dd><dt>Billing</dt><dd>Renews until you cancel</dd></dl>
    <p class="muted">Cancelling keeps access until the end of the paid period.</p>
    <p class="actions"><button type="button" id="start-subscription" data-tier-id="${e(tier.id)}">Continue to payment</button></p></section>`;
}
const day=value=>when(value,{time:false});
const subscriptionStatus=s=>s.cancel_at_period_end?'Cancelled: access until '+day(s.current_period_end):
  ({active:'Active: renews '+day(s.current_period_end),past_due:'Payment failed: access during the grace period',ended:'Ended'})[s.status]??e(s.status);
export function renderSubscriptions({hub,subscriptions,testMode}) {
  const rows=subscriptions.map(s=>`<tr><td><strong>${e(s.title)}</strong></td><td class="num">${e(formatRand(s.amount_cents))} ${per(s.billing_interval)}</td><td><span class="meta">${badge(s.cancel_at_period_end?'closed':s.status,'')}<span>${subscriptionStatus(s)}</span></span></td>
    <td><div class="actions">${['active','past_due'].includes(s.status)&&!s.cancel_at_period_end?`<button type="button" class="cancel-subscription" data-subscription-id="${e(s.id)}">Cancel</button>`:''}
    ${testMode&&s.psp_reference&&s.status!=='ended'?`<a href="/test-payments/subscriptions/${e(encodeURIComponent(s.psp_reference))}">Simulate renewal (test)</a>`:''}</div></td></tr>`).join('');
  return `<h1>Your subscriptions</h1><section>${rows?`<div class="table"><table><thead><tr><th>Subscription</th><th class="num">Price</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`:'<p class="muted">No subscriptions yet.</p>'}</section>
    <p><a href="/h/${e(hub.slug)}/membership">Membership tiers</a></p>`;
}
/** TEST MODE: stands in for the provider charging a stored card at renewal. */
export function renderTestSubscription(subscription,outcome) {
  const ref=encodeURIComponent(subscription.reference);
  return standIn('Test renewals','TEST MODE: no real money moves. This page stands in for the provider\'s renewal charges.',
    `<p class="eyebrow">Subscription</p><h1>${e(subscription.description??'Subscription')}</h1>
<section class="panel"><dl class="facts"><dt>Renewal amount</dt><dd class="price">${e(formatRand(subscription.amountCents))}</dd></dl>
${outcome?`<p role="status">Last result: <strong>${e(outcome)}</strong></p>`:''}${subscription.active?`<div class="actions"><form method="post" action="/test-payments/subscriptions/${ref}/renew"><button>Simulate successful renewal</button></form>
<form method="post" action="/test-payments/subscriptions/${ref}/fail"><button type="submit" class="decline">Simulate failed renewal</button></form></div>`:'<p class="muted">Renewals have stopped (cancelled).</p>'}</section>`);
}
export function renderOrders({hub,orders}) {
  const rows=orders.map(o=>`<tr><td><a href="/h/${e(hub.slug)}/orders/${e(o.id)}">${e(o.title)}</a></td><td class="num">${e(formatRand(o.total_cents))}</td><td>${badge(o.status,statuses[o.status])}</td><td>${when(o.created_at)}</td></tr>`).join('');
  return `<h1>Your orders</h1><section>${rows?`<div class="table"><table><thead><tr><th>Product</th><th class="num">Total</th><th>Status</th><th>Placed</th></tr></thead><tbody>${rows}</tbody></table></div>`:'<p class="muted">No orders yet.</p>'}</section>`;
}
export function renderOrder({hub,order}) {
  const next=order.status==='paid'&&order.kind==='seats'?`<p class="actions"><a class="button primary" href="/h/${e(hub.slug)}/seats">Assign the ${e(order.quantity)} seats</a></p>`:
    order.status==='paid'?`<p class="actions"><a class="button primary" href="/h/${e(hub.slug)}/learning">Start learning</a></p>`:
    order.status==='pending'?'<p class="muted">We are waiting for the payment provider to confirm. Refresh this page in a moment.</p>':
    order.status==='failed'?`<p class="actions"><a class="button primary" href="/h/${e(hub.slug)}/products/${e(order.product_id)}">Try again</a></p>`:'<p class="muted">The provider will review this order.</p>';
  return `<p class="crumb"><a href="/h/${e(hub.slug)}/orders">All orders</a></p><h1>${e(order.title)}</h1>
    <section><p class="meta">Status: ${badge(order.status,statuses[order.status])}</p><dl class="facts"><dt>Total</dt><dd class="price">${e(formatRand(order.total_cents))}</dd><dt>Of which VAT</dt><dd>${e(formatRand(order.vat_cents))}</dd></dl>${next}</section>`;
}
const accounts={buyer_payment:'Buyer payments',provider_revenue:'Your revenue',vat_payable:'VAT payable',payment_fees:'Payment fees'};
export function renderSales({hub,sales}) {
  const revenue=sales.ledger.find(l=>l.account==='provider_revenue');
  const ledger=sales.ledger.map(l=>`<tr><td>${e(accounts[l.account]??l.account)}</td><td class="num">${e(formatRand(l.debit_cents))}</td><td class="num">${e(formatRand(l.credit_cents))}</td></tr>`).join('');
  const orders=sales.orders.map(o=>`<tr><td>${e(o.title)}</td><td class="num">${e(formatRand(o.total_cents))}</td><td>${badge(o.status,statuses[o.status])}</td><td><code title="${e(o.buyer_id)}">${e(String(o.buyer_id).slice(0,8))}</code></td><td>${when(o.created_at)}</td>
    <td>${o.status==='paid'?`<button type="button" class="refund-order" data-order-id="${e(o.id)}">Refund</button>`:''}</td></tr>`).join('');
  return `<h1>Sales</h1>${revenue?`<section><p class="eyebrow">Your revenue to date</p><p class="figure">${e(formatRand(Number(revenue.credit_cents)-Number(revenue.debit_cents)))}</p><p class="muted">After VAT and payment fees, net of refunds.</p></section>`:''}
    <section><h2>Ledger</h2><p class="muted">Double-entry totals. Entries are never edited; corrections are reversing entries.</p>
    ${ledger?`<div class="table"><table><thead><tr><th>Account</th><th class="num">Debits</th><th class="num">Credits</th></tr></thead><tbody>${ledger}</tbody></table></div>`:'<p class="muted">No sales yet.</p>'}</section>
    <section><h2>Orders</h2>${orders?`<div class="table"><table><thead><tr><th>Product</th><th class="num">Total</th><th>Status</th><th>Buyer account</th><th>Placed</th><th></th></tr></thead><tbody>${orders}</tbody></table></div>`:'<p class="muted">No orders yet.</p>'}</section>`;
}
