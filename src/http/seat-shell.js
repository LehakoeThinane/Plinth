import { escapeText as e } from './storefront.js';
import { when,badge } from './ui.js';
const person=p=>p.name||'Member '+String(p.userId).slice(0,8);
const sourceLabel=(pool,hub)=>pool.source==='purchase'?'Bought on '+e(hub.display_name):`Granted by ${e(hub.display_name)} · reference <code>${e(pool.reference)}</code>`;
function usage(pool) {
  const used=pool.holders.length;
  return `<progress max="${e(pool.seats)}" value="${used}" aria-label="Seats in use"></progress><p class="count">${used} of ${e(pool.seats)} seat${pool.seats===1?'':'s'} in use</p>`;
}
/** A company admin's seats in this hub: who holds each seat, and who can get one. */
export function renderCompanySeats({hub,seats}) {
  const {companies,org,overview}=seats,base='/h/'+e(hub.slug);
  if(!companies.length)return `<h1>Company seats</h1><section><p>You are not an administrator of any organisation.</p>
    <p class="muted">Company administrators give their colleagues seats on courses here. To set up a company, go to <a href="${base}/organisations">Organisations</a>.</p></section>`;
  const switcher=companies.length>1?`<p class="meta">${companies.map(c=>c.id===org.id?`<strong>${e(c.display_name)}</strong>`:`<a href="${base}/seats?org=${e(c.id)}">${e(c.display_name)}</a>`).join('')}</p>`:'';
  const pools=overview.pools.map(pool=>{
    const held=new Set(pool.holders.map(h=>h.userId)),open=pool.status==='active'&&pool.holders.length<pool.seats;
    const candidates=overview.members.filter(m=>!held.has(m.userId));
    const rows=pool.holders.map(h=>`<tr><td><strong>${e(person(h))}</strong>${h.stillMember?'':' <span class="badge warn">Left the organisation</span>'}</td><td>${when(h.assignedAt)}</td>
      <td>${pool.status==='active'?`<button type="button" class="revoke-seat" data-pool-id="${e(pool.id)}" data-user-id="${e(h.userId)}" data-name="${e(person(h))}">Take back</button>`:''}</td></tr>`).join('');
    const assign=pool.status!=='active'?'<p class="muted">These seats have ended.</p>':!open?'<p class="muted">All seats are in use. Take one back to give it to someone else.</p>':
      candidates.length?`<form class="assign-seat" data-pool-id="${e(pool.id)}"><label>Give a seat to<select name="userId" required>${candidates.map(m=>`<option value="${e(m.userId)}">${e(person(m))}</option>`).join('')}</select></label><button>Give seat</button></form>`:
      `<p class="muted">Everyone in the organisation already has a seat. Invite colleagues from <a href="${base}/organisations?org=${e(org.id)}">Organisations</a> first.</p>`;
    return `<section><div class="section-head"><h2>${e(pool.productTitle??'Course')}</h2>${badge(pool.status)}</div>
      <p class="meta"><span>${sourceLabel(pool,hub)}</span><span>since ${when(pool.createdAt,{time:false})}</span></p>${usage(pool)}
      ${rows?`<div class="table"><table><thead><tr><th>Seat holder</th><th>Since</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`:'<p class="muted">Nobody holds a seat yet.</p>'}${assign}</section>`;
  }).join('');
  return `<h1>Company seats</h1><p class="lede">${e(org.display_name)} in ${e(hub.display_name)}</p>${switcher}
    <p class="muted">A seat gives one colleague access to a course. Taking a seat back ends their access straight away and frees the seat. You see who holds a seat here, never anyone's own purchases.</p>
    ${pools||`<section><p>${e(org.display_name)} has no seats here yet.</p><p class="muted">Buy seats from a course page, or <a href="${base}/enquiries">ask ${e(hub.display_name)} about a company deal</a>.</p></section>`}`;
}
/** Hub owners/admins: every company's seats, and grants for deals paid off the platform. */
export function renderSeatAdmin({hub,seats}) {
  const {overview,products}=seats;
  const rows=overview.pools.map(pool=>`<tr><td><strong title="Organisation ID ${e(pool.orgId)}">${e(pool.orgName??'Organisation')}</strong></td><td>${e(pool.productTitle??'')}</td>
    <td class="num">${pool.holders.length} / ${e(pool.seats)}</td><td>${pool.source==='purchase'?'Bought':'Granted · <code>'+e(pool.reference)+'</code>'}</td><td>${badge(pool.status)}</td>
    <td>${pool.source==='provider_grant'&&pool.status==='active'?`<button type="button" class="end-pool" data-pool-id="${e(pool.id)}">End grant</button>`:''}</td></tr>`).join('');
  const options=products.map(p=>`<option value="${e(p.id)}"${p.company_org?` data-org="${e(p.company_org)}"`:''}>${e(p.title)}${p.company_org?' (company product)':''}</option>`).join('');
  return `<h1>Company seats</h1><p class="muted">Seats companies hold in your hub. Company administrators assign them to their own people.</p>
    <section><h2>Seat pools</h2>${rows?`<div class="table"><table><thead><tr><th>Company</th><th>Product</th><th class="num">In use</th><th>Source</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`:'<p class="muted">No company holds seats yet.</p>'}</section>
    <form id="grant-seats"><h2>Grant seats for an off-platform deal</h2>
    <p class="muted">Use this when a company paid you directly, for example on an invoice. No money moves on the platform; the reference is kept for your records. A company product's seats can only go to its own organisation.</p>
    ${options?`<label>Product<select name="productId" required>${options}</select></label>
    <label>Organisation ID <small>(filled in for company products; otherwise the ID the company admin sees on their Organisations page)</small><input name="orgId" required pattern="[0-9a-fA-F-]{36}"></label>
    <label>Number of seats<input name="seats" type="number" min="1" max="10000" required value="10"></label>
    <label>Reference <small>(purchase order, invoice or contract number)</small><input name="reference" required maxlength="100" placeholder="PO-2026-0142"></label>
    <button>Grant seats</button>`:'<p class="muted">Create a paid product first.</p>'}</form>`;
}
