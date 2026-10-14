import { escapeText as e,formatRand } from './storefront.js';
import { badge } from './ui.js';
const types={product:'Course',space:'Community space',library:'Library item'};
const price=t=>formatRand(t.amount_cents)+' per '+(t.billing_interval==='year'?'year':'month');
function tierFields(t={},locked=false) {
  return `<label>Name<input name="name" required maxlength="80" value="${e(t.name)}"></label>
    <label>Description<textarea name="description" maxlength="2000">${e(t.description)}</textarea></label>
    <label>Rank <small>(1 is the entry tier; higher ranks are upgrades)</small><input name="rank" type="number" min="1" max="100" required value="${e(t.rank??1)}"></label>
    <label>Price in rand<input name="amount" inputmode="decimal" required pattern="[0-9]+([.,][0-9]{1,2})?" value="${t.amount_cents?e((t.amount_cents/100).toFixed(2)):''}"${locked?' disabled':''}></label>
    <label>Billing period<select name="interval"${locked?' disabled':''}><option value="month"${t.billing_interval!=='year'?' selected':''}>Monthly</option><option value="year"${t.billing_interval==='year'?' selected':''}>Yearly</option></select></label>`;
}
export function renderTiers({hub,tiers}) {
  const rows=tiers.map(t=>`<tr><td><a href="/h/${e(hub.slug)}/admin/tiers/${e(t.id)}">${e(t.name)}</a></td><td class="num">${e(t.rank)}</td><td class="num">${e(price(t))}</td>
    <td>${badge(t.status)}</td><td class="num">${e(t.benefits.length)}</td></tr>`).join('');
  return `<h1>Membership tiers</h1><p class="muted">A hub can offer no tiers, one, or several ranked tiers. Members subscribe from the Membership page.</p>
    <section>${rows?`<div class="table"><table><thead><tr><th>Tier</th><th class="num">Rank</th><th class="num">Price</th><th>Status</th><th class="num">Benefits</th></tr></thead><tbody>${rows}</tbody></table></div>`:'<p class="muted">No tiers yet.</p>'}</section>
    <form id="create-tier"><h2>Create a tier</h2>${tierFields()}<button>Create draft tier</button></form>`;
}
export function renderTierEditor({hub,tier,candidates}) {
  const locked=tier.status!=='draft',held=new Set(tier.benefits.map(b=>b.target_id));
  const benefits=tier.benefits.map(b=>`<li><p class="meta"><span class="eyebrow">${e(types[b.target_type])}</span><strong>${e(b.title)}</strong><button type="button" class="remove-benefit" data-target-id="${e(b.target_id)}">Remove</button></p></li>`).join('');
  const options=candidates.filter(c=>!held.has(c.target_id)).map(c=>`<option value="${e(c.target_type)}:${e(c.target_id)}">${e(types[c.target_type])}: ${e(c.title)}</option>`).join('');
  return `<p class="crumb"><a href="/h/${e(hub.slug)}/admin/tiers">All tiers</a></p><h1>${e(tier.name)}</h1><p class="meta">${badge(tier.status)}<span class="price">${e(price(tier))}</span></p>
    <form id="tier-details" data-tier-id="${e(tier.id)}"><h2>Details</h2>${tierFields(tier,locked)}${locked?'<p class="muted">The price is fixed once published; create a new tier to change it.</p>':''}<button>Save tier</button></form>
    <section><h2>Benefits</h2><p class="muted">Members holding this tier can open these. Library and community items must be set to tier (or buyer) visibility to need a tier.</p>
    <ul class="rows">${benefits||'<li class="muted">No benefits yet.</li>'}</ul>
    ${tier.status==='archived'?'':`<form id="add-benefit" data-tier-id="${e(tier.id)}"><label>Add a benefit<select name="benefit" required>${options||'<option value="" disabled selected>No eligible items</option>'}</select></label><button${options?'':' disabled'}>Add benefit</button></form>`}</section>
    <section><h2>Availability</h2><p class="actions">${tier.status==='draft'?'<button type="button" class="tier-status" data-action="publish">Publish tier</button>':''}
    ${tier.status!=='archived'?'<button type="button" class="tier-status" data-action="archive">Archive tier</button>':'<span class="muted">This tier is archived.</span>'}</p></section>`;
}
