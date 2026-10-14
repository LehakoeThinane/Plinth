import { escapeText as e } from './storefront.js';
import { renderOrganisations } from './organisation-shell.js';
import { renderAccount } from './account-shell.js';
import { renderProducts,renderProductEditor } from './catalogue-shell.js';
import { renderLearning } from './learning-shell.js';
import { renderLibraryAdmin,renderLibraryEditor } from './library-shell.js';
import { renderCommunity,renderSpace,renderPostPage,renderCommunityAdmin } from './community-shell.js';
import { renderEnquiries,renderEnquiry } from './enquiry-shell.js';
import { renderTiers,renderTierEditor } from './tier-shell.js';
import { renderCheckout,renderOrders,renderOrder,renderSales } from './commerce-shell.js';
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
    ${consents.map(n=>`<form class="publish-notice" data-expected-version="${e(n.notice_version)}"><h3>${e(n.purpose)} · ${n.retired?'retired':'current'} ${e(n.notice_version)}</h3>${noticeFields(n)}
      ${n.retired?'':`<button type="button" class="retire-notice" data-purpose="${e(n.purpose)}" data-version="${e(n.notice_version)}">Retire purpose</button>`}</form>`).join('')}
    <h3>Notice history</h3><ul>${publications.map(n=>`<li>${e(n.purpose)} · ${e(n.notice_version)} · ${n.kind==='retired'?'retired':'published'} · ${e(n.at??'Imported; original date unknown')}${n.kind==='retired'?'':`<p>${e(n.notice_text??'Historic text unavailable or conflicting; consult consent snapshots.')}</p>`}</li>`).join('')||'<li>No publications yet.</li>'}</ul>
    ${olderNotices?`<p><a href="/h/${e(hub.slug)}/admin?notices_before=${encodeURIComponent(olderNotices)}">Older entries</a></p>`:''}</section>`;
  const domainAdmin=domains?`<section><h2>Custom domain ownership</h2><p>Verify DNS ownership here. HTTPS and domain activation are arranged separately.</p>
    <form id="domain-request"><label>Hostname<input name="hostname" maxlength="232" placeholder="learn.yourcompany.co.za" required></label><button>Create or replace DNS proof</button></form>
    <p id="domain-proof" role="status"></p><ul>${domains.claims.map(d=>`<li>${e(d.hostname)} · proof expires ${e(d.expires_at)} <button class="verify-domain" data-hostname="${e(d.hostname)}">Check DNS</button> <button class="remove-domain" data-hostname="${e(d.hostname)}">Remove</button></li>`).join('')}${domains.verified.map(d=>`<li>${e(d.hostname)} · ownership verified <button class="remove-domain" data-hostname="${e(d.hostname)}">Remove</button></li>`).join('')}</ul></section>`:'';
  const content=view==='checkout'?renderCheckout({hub,...commerce}):view==='orders'?renderOrders({hub,orders:commerce.orders}):
    view==='order'?renderOrder({hub,order:commerce.order}):view==='sales'?renderSales({hub,sales:commerce.sales}):view==='tiers'?renderTiers({hub,tiers:catalogue.tiers}):view==='tier'?renderTierEditor({hub,tier:catalogue.tier,candidates:catalogue.candidates}):
    view==='enquiries'?renderEnquiries({hub,inbox:enquiries.inbox}):view==='enquiry'?renderEnquiry({hub,thread:enquiries.thread,userId:enquiries.userId}):
    view==='community'?renderCommunity({hub,spaces:community.spaces}):view==='space'?renderSpace({hub,space:community.space,feed:community.feed,userId:community.userId}):
    view==='post'?renderPostPage({hub,thread:community.thread,userId:community.userId}):view==='community-admin'?renderCommunityAdmin({hub,spaces:community.spaces,reports:community.reports}):
    view==='library'?renderLibraryAdmin({hub,items:catalogue.items}):view==='library-item'?renderLibraryEditor({hub,item:catalogue.item,products:catalogue.products}):view==='learning'?renderLearning({hub,learning}):view==='products'?renderProducts({hub,products:catalogue.products}):view==='product'?renderProductEditor({hub,detail:catalogue.detail,opens:catalogue.opens}):view==='organisations'?renderOrganisations({hub,account,organisation,orgDomains}):view==='account'?renderAccount({hub,account,signIn}):view==='create-hub'?`<h1>Create a learning hub</h1><form id="create-hub">
    <label>Hub name<input name="displayName" maxlength="200" required></label>
    <label>Hub address<input name="slug" minlength="3" maxlength="63" pattern="[a-z0-9]+(-[a-z0-9]+)*" required aria-describedby="slug-help"></label>
    <p id="slug-help">Use lowercase letters, numbers and single hyphens.</p><button type="submit">Create hub</button></form>`:
    view==='admin'?`<h1>Manage ${e(hub.display_name)}</h1><form id="branding"><h2>Hub branding</h2>
    <label>Hub name<input name="displayName" maxlength="200" required value="${e(hub.display_name)}"></label>
    <label>Description<textarea name="description" maxlength="2000">${e(hub.description)}</textarea></label>
    <label>Primary colour<input type="color" name="primaryColor" value="${e(hub.primary_color)}"></label>
    <label>Font<select name="font">${['system','serif','sans'].map(f=>`<option value="${f}"${hub.font===f?' selected':''}>${f}</option>`).join('')}</select></label>
    <button type="submit">Save branding</button></form>${brandingEnabled?`<form id="logo"><h2>Hub logo</h2>${hub.logo_path?`<img src="${e(hub.logo_path)}" alt="Current hub logo" width="128">`:''}<p>Your logo appears publicly on the hub. Choose a static PNG, JPEG or WebP up to 2 MB.</p><label>Logo image<input type="file" name="image" accept="image/png,image/jpeg,image/webp" required></label><button>Upload logo</button> <button type="button" id="remove-logo">Remove logo</button></form>`:''}${domainAdmin}${noticeAdmin}`:
    view==='join'?`<h1>Join ${e(hub.display_name)}</h1><p>Join this learning hub with your account.</p>
    <form id="join"><h2>Optional consent</h2><p>Joining does not require optional consent.</p>${choices}<button type="submit">Join hub</button></form>`:
    `<h1>Your member area</h1><p>Welcome to ${e(hub.display_name)}.</p><section><h2>Your learning</h2><p>Your courses will appear here as they become available.</p></section>${consentForm}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${e(hub.display_name)} · ${e(view)}</title><style>
*{box-sizing:border-box}body{font-family:system-ui,sans-serif;margin:0;color:#172334;background:#f6f7fa;line-height:1.6}
header{background:white;border-bottom:1px solid #dce2ea;padding:20px}nav{max-width:900px;margin:auto;display:flex;gap:20px;align-items:center;flex-wrap:wrap}
main{max-width:900px;padding:32px 20px;margin:auto}h1{font-size:2rem}form,section{background:white;border:1px solid #dce2ea;border-radius:12px;padding:24px;margin:24px 0}
label{display:block;margin:16px 0}input:not([type=checkbox]),textarea,select{display:block;padding:10px;width:100%;font:inherit;border:1px solid #9baabd;border-radius:6px}
textarea{min-height:100px}input[type=color]{height:48px;max-width:160px}.choice{display:flex;gap:12px;align-items:flex-start}.choice input{margin-top:7px}
button{font:inherit;padding:10px 16px;border-radius:6px;border:0;background:#2456A6;color:white;cursor:pointer}button:disabled{opacity:.6}a{color:#2456A6}
#status{min-height:24px}h2{margin-top:0}
table{width:100%;border-collapse:collapse;display:block;overflow-x:auto}th,td{text-align:left;padding:8px;border-bottom:1px solid #dce2ea}
</style><script defer src="/assets/plinth-shell.js"></script></head>
<body data-hub-id="${e(hub.id)}" data-slug="${e(hub.slug)}" data-csrf="${e(csrfToken)}" data-org-id="${e(organisation?.organisation.id)}" data-product-id="${e(catalogue?.detail?.product.id)}"><header><nav>
<a href="/h/${e(hub.slug)}">${e(hub.display_name)}</a><a href="/h/${e(hub.slug)}/member">Member area</a>
<a href="/h/${e(hub.slug)}/learning">My learning</a>
<a href="/h/${e(hub.slug)}/community">Community</a>
<a href="/h/${e(hub.slug)}/enquiries">Enquiries</a>
<a href="/h/${e(hub.slug)}/orders">Orders</a>
<a href="/h/${e(hub.slug)}/create-hub">Create a hub</a>
<a href="/h/${e(hub.slug)}/organisations">Organisations</a>
<a href="/h/${e(hub.slug)}/account">Account</a>
${membership && ['owner','admin'].includes(membership.role)?`<a href="/h/${e(hub.slug)}/admin">Hub admin</a><a href="/h/${e(hub.slug)}/admin/products">Products</a><a href="/h/${e(hub.slug)}/admin/library">Library</a><a href="/h/${e(hub.slug)}/admin/tiers">Tiers</a><a href="/h/${e(hub.slug)}/admin/sales">Sales</a><a href="/h/${e(hub.slug)}/admin/community">Moderation</a>`:''}
<button type="button" id="logout">Sign out</button></nav></header><main>${content}<p id="status" role="status" aria-live="polite"></p></main></body></html>`;
}
