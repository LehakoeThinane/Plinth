import { escapeText as e,hubBar,plinthFooter } from './storefront.js';
import { head,when,badge } from './ui.js';
import { renderOrganisations } from './organisation-shell.js';
import { renderAccount } from './account-shell.js';
import { renderProducts,renderProductEditor } from './catalogue-shell.js';
import { renderLearning } from './learning-shell.js';
import { renderLibraryAdmin,renderLibraryEditor } from './library-shell.js';
import { renderCommunity,renderSpace,renderPostPage,renderCommunityAdmin } from './community-shell.js';
import { renderEnquiries,renderEnquiry } from './enquiry-shell.js';
import { renderTiers,renderTierEditor } from './tier-shell.js';
import { renderCheckout,renderOrders,renderOrder,renderSales,renderSubscribe,renderSubscriptions } from './commerce-shell.js';
export function renderApplicationShell({hub,view,membership,consents,csrfToken,account,signIn,organisation,orgDomains,catalogue,learning,community,enquiries,commerce,publications=[],olderNotices=null,brandingEnabled=false,domains}) {
  // Retired purposes are no longer offered; their old grants are inactive.
  const choices=consents.filter(c=>!c.retired).map(c=>`<label class="choice"><input type="checkbox" name="${e(c.purpose)}" data-purpose="${e(c.purpose)}" data-version="${e(c.notice_version)}"${c.granted?' checked':''}>
    <span><strong>${e(c.purpose.replaceAll('_',' '))}</strong><br>${e(c.notice_text)}</span></label>`).join('');
  const consentForm=`<form id="consents"><h2>Your consent choices</h2><p>These choices apply only to ${e(hub.display_name)}. You can withdraw them here.</p>${choices||'<p>No optional consent choices are available.</p>'}${choices?'<button type="submit">Save choices</button>':''}</form>`;
  const noticeFields=(notice=null)=>`<label>Purpose key<input name="purpose" required pattern="[a-z][a-z0-9_]{0,63}" maxlength="64" value="${e(notice?.purpose)}"${notice?' readonly':''}></label>
    <label>New version<input name="noticeVersion" required maxlength="100"></label>
    <label>Notice text<textarea name="noticeText" required maxlength="10000">${e(notice?.notice_text)}</textarea></label>
    <button>Publish notice</button>`;
  const noticeAdmin=`<section><h2>Consent notices</h2><p>Each publication needs a new version. Publishing a revision makes older grants inactive until the member agrees again. Retiring a purpose stops offering it and makes existing grants inactive; members can still withdraw. To offer it again, publish a new version. Optional consent remains optional.</p>
    <form class="publish-notice" data-expected-version=""><h3>New purpose</h3>${noticeFields()}</form>
    ${consents.map(n=>`<form class="publish-notice" data-expected-version="${e(n.notice_version)}"><h3>${e(n.purpose.replaceAll('_',' '))}</h3>
      <p class="meta">${badge(n.retired?'retired':'current')}<span>Version <code>${e(n.notice_version)}</code></span></p>${noticeFields(n)}
      ${n.retired?'':`<button type="button" class="retire-notice" data-purpose="${e(n.purpose)}" data-version="${e(n.notice_version)}">Retire purpose</button>`}</form>`).join('')}
    <h3>Notice history</h3><ul class="rows">${publications.map(n=>`<li><p class="meta"><strong>${e(n.purpose)}</strong><code>${e(n.notice_version)}</code>${badge(n.kind==='retired'?'retired':'published')}<span>${n.at?when(n.at):'Imported; original date unknown'}</span></p>${n.kind==='retired'?'':`<p>${e(n.notice_text??'Historic text unavailable or conflicting; consult consent snapshots.')}</p>`}</li>`).join('')||'<li class="muted">No publications yet.</li>'}</ul>
    ${olderNotices?`<p><a href="/h/${e(hub.slug)}/admin?notices_before=${encodeURIComponent(olderNotices)}">Older entries</a></p>`:''}</section>`;
  const domainAdmin=domains?`<section><h2>Custom domain ownership</h2><p class="muted">Verify DNS ownership here. HTTPS and domain activation are arranged separately.</p>
    <form id="domain-request"><label>Hostname<input name="hostname" maxlength="232" placeholder="learn.yourcompany.co.za" required></label><button>Create or replace DNS proof</button></form>
    <p id="domain-proof" role="status"></p><ul class="rows">${domains.claims.map(d=>`<li><p class="meta"><strong>${e(d.hostname)}</strong>${badge('pending','Waiting for DNS')}<span>proof expires ${when(d.expires_at)}</span></p><p class="actions"><button class="verify-domain" data-hostname="${e(d.hostname)}">Check DNS</button><button class="remove-domain" data-hostname="${e(d.hostname)}">Remove</button></p></li>`).join('')}${domains.verified.map(d=>`<li><p class="meta"><strong>${e(d.hostname)}</strong>${badge('active','Ownership verified')}</p><p class="actions"><button class="remove-domain" data-hostname="${e(d.hostname)}">Remove</button></p></li>`).join('')}</ul></section>`:'';
  const content=view==='subscribe'?renderSubscribe({hub,tier:commerce.tier}):view==='subscriptions'?renderSubscriptions({hub,...commerce}):view==='checkout'?renderCheckout({hub,...commerce}):view==='orders'?renderOrders({hub,orders:commerce.orders}):
    view==='order'?renderOrder({hub,order:commerce.order}):view==='sales'?renderSales({hub,sales:commerce.sales}):view==='tiers'?renderTiers({hub,tiers:catalogue.tiers}):view==='tier'?renderTierEditor({hub,tier:catalogue.tier,candidates:catalogue.candidates}):
    view==='enquiries'?renderEnquiries({hub,inbox:enquiries.inbox}):view==='enquiry'?renderEnquiry({hub,thread:enquiries.thread,userId:enquiries.userId}):
    view==='community'?renderCommunity({hub,spaces:community.spaces}):view==='space'?renderSpace({hub,space:community.space,feed:community.feed,userId:community.userId}):
    view==='post'?renderPostPage({hub,thread:community.thread,userId:community.userId}):view==='community-admin'?renderCommunityAdmin({hub,spaces:community.spaces,reports:community.reports}):
    view==='library'?renderLibraryAdmin({hub,items:catalogue.items}):view==='library-item'?renderLibraryEditor({hub,item:catalogue.item,products:catalogue.products}):view==='learning'?renderLearning({hub,learning}):view==='products'?renderProducts({hub,products:catalogue.products}):view==='product'?renderProductEditor({hub,detail:catalogue.detail,opens:catalogue.opens}):view==='organisations'?renderOrganisations({hub,account,organisation,orgDomains}):view==='account'?renderAccount({hub,account,signIn}):view==='create-hub'?`<h1>Create a learning hub</h1><form id="create-hub">
    <label>Hub name<input name="displayName" maxlength="200" required></label>
    <label>Hub address<input name="slug" minlength="3" maxlength="63" pattern="[a-z0-9]+(-[a-z0-9]+)*" required aria-describedby="slug-help"></label>
    <p id="slug-help">Use lowercase letters, numbers and single hyphens.</p><button type="submit">Create hub</button></form>`:
    view==='admin'?`<h1>Manage ${e(hub.display_name)}</h1><p class="muted">How your hub looks to visitors, and what members agree to.</p><form id="branding"><h2>Hub branding</h2>
    <label>Hub name<input name="displayName" maxlength="200" required value="${e(hub.display_name)}"></label>
    <label>Description <small>(shown under your name on the storefront)</small><textarea name="description" maxlength="2000">${e(hub.description)}</textarea></label>
    <label>Primary colour <small>(used for the storefront banner, buttons and links)</small><input type="color" name="primaryColor" value="${e(hub.primary_color)}"></label>
    <label>Heading style<select name="font">${[['system','Plain (the device font)'],['serif','Serif (Newsreader)'],['sans','Sans serif (Archivo)']].map(([f,l])=>`<option value="${f}"${hub.font===f?' selected':''}>${l}</option>`).join('')}</select></label>
    <button type="submit">Save branding</button></form>${brandingEnabled?`<form id="logo"><h2>Hub logo</h2>${hub.logo_path?`<img src="${e(hub.logo_path)}" alt="Current hub logo" width="128">`:''}<p class="muted">Your logo appears publicly on the hub. Choose a static PNG, JPEG or WebP up to 2 MB.</p><label>Logo image<input type="file" name="image" accept="image/png,image/jpeg,image/webp" required></label><p class="actions"><button>Upload logo</button><button type="button" id="remove-logo">Remove logo</button></p></form>`:''}${domainAdmin}${noticeAdmin}`:
    view==='join'?`<h1>Join ${e(hub.display_name)}</h1><p class="lede">Join this learning hub with your account. Membership is free.</p>
    <form id="join"><h2>Optional consent</h2><p class="muted">Joining does not require optional consent.</p>${choices}<button type="submit">Join hub</button></form>`:
    `<h1>Your member area</h1><p class="lede">Welcome to ${e(hub.display_name)}.</p><section><h2>Where to go next</h2><ul class="rows">
      <li><h3><a href="/h/${e(hub.slug)}/learning">My learning</a></h3><p class="muted">Pick up your courses where you left off.</p></li>
      <li><h3><a href="/h/${e(hub.slug)}/community">Community</a></h3><p class="muted">Ask questions and share progress with other members.</p></li>
      <li><h3><a href="/h/${e(hub.slug)}/membership">Membership tiers</a></h3><p class="muted">Add courses, spaces and library items with a tier.</p></li></ul></section>${consentForm}`;
  const base='/h/'+e(hub.slug),admin=Boolean(membership&&['owner','admin'].includes(membership.role));
  const area=adminArea[view]??memberArea[view]??null;
  const link=(href,label,key)=>`<a href="${base}${href}"${area===key?' aria-current="page"':''}>${label}</a>`;
  const nav=link('','Courses','shelf')+link('/learning','My learning','learning')+link('/community','Community','community')+
    link('/library','Library','library-public')+link('/enquiries','Enquiries','enquiries')+(admin?link('/admin','Manage hub','manage'):'')+
    `<details class="account"><summary>Account</summary><div class="menu">${link('/member','Member area','member')}${link('/orders','Orders','orders')}
    ${link('/subscriptions','Subscriptions','subscriptions')}${link('/organisations','Organisations','organisations')}${link('/account','Sign-in methods','account')}
    ${link('/create-hub','Create a hub','create-hub')}<hr><button type="button" id="logout">Sign out</button></div></details>`;
  const consoleNav=admin&&adminArea[view]?`<nav class="sidenav" aria-label="Manage ${e(hub.display_name)}"><span class="eyebrow">Manage hub</span>
    ${[['/admin','Branding and notices','branding'],['/admin/products','Products','products'],['/admin/library','Library','library'],['/admin/tiers','Membership tiers','tiers'],
      ['/admin/community','Community','moderation'],['/admin/sales','Sales','sales'],['/enquiries','Enquiries inbox','inbox']].map(([href,label,key])=>link(href,label,key)).join('')}</nav>`:'';
  const status='<p id="status" role="status" aria-live="polite"></p>';
  return `${head({title:(titles[view]??view)+' · '+hub.display_name,hub,script:true})}
<body data-hub-id="${e(hub.id)}" data-slug="${e(hub.slug)}" data-csrf="${e(csrfToken)}" data-org-id="${e(organisation?.organisation.id)}" data-product-id="${e(catalogue?.detail?.product.id)}">
${hubBar(hub,nav)}<main id="main">${consoleNav?`<div class="wrap console">${consoleNav}<div class="content">${content}${status}</div></div>`:
  `<div class="wrap page"><div class="content">${content}${status}</div></div>`}</main>${plinthFooter(hub)}</body></html>`;
}
// Which navigation entry each view belongs to.
const adminArea={admin:'branding',products:'products',product:'products',library:'library','library-item':'library',tiers:'tiers',tier:'tiers','community-admin':'moderation',sales:'sales'};
const memberArea={learning:'learning',community:'community',space:'community',post:'community',enquiries:'enquiries',enquiry:'enquiries',member:'member',join:'member',
  orders:'orders',order:'orders',subscriptions:'subscriptions',subscribe:'subscriptions',checkout:'shelf',organisations:'organisations',account:'account','create-hub':'create-hub'};
const titles={admin:'Manage hub',products:'Products',product:'Product',library:'Library','library-item':'Library item',tiers:'Membership tiers',tier:'Tier','community-admin':'Community moderation',
  sales:'Sales',learning:'My learning',community:'Community',space:'Community',post:'Post',enquiries:'Enquiries',enquiry:'Enquiry',member:'Member area',join:'Join',orders:'Orders',order:'Order',
  subscriptions:'Subscriptions',subscribe:'Subscribe',checkout:'Checkout',organisations:'Organisations',account:'Sign-in methods','create-hub':'Create a hub'};
