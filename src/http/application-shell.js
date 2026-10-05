import { escapeText as e } from './storefront.js';
import { renderOrganisations } from './organisation-shell.js';
export function renderApplicationShell({hub,view,membership,consents,csrfToken,account,organisation,publications=[],brandingEnabled=false,domains}) {
  const choices=consents.map(c=>`<label class="choice"><input type="checkbox" name="${e(c.purpose)}" data-purpose="${e(c.purpose)}" data-version="${e(c.notice_version)}"${c.granted?' checked':''}>
    <span><strong>${e(c.purpose.replaceAll('_',' '))}</strong><br>${e(c.notice_text)}</span></label>`).join('');
  const consentForm=`<form id="consents"><h2>Your consent choices</h2><p>These choices apply only to ${e(hub.display_name)}. You can withdraw them here.</p>${choices||'<p>No optional consent choices are available.</p>'}${choices?'<button type="submit">Save choices</button>':''}</form>`;
  const noticeFields=(notice=null)=>`<label>Purpose key<input name="purpose" required pattern="[a-z][a-z0-9_]{0,63}" maxlength="64" value="${e(notice?.purpose)}"${notice?' readonly':''}></label>
    <label>New version<input name="noticeVersion" required maxlength="100"></label>
    <label>Notice text<textarea name="noticeText" required maxlength="10000">${e(notice?.notice_text)}</textarea></label>
    <button>Publish notice</button>`;
  const noticeAdmin=`<section><h2>Consent notices</h2><p>Each publication needs a new version. Publishing a revision makes older grants inactive until the member agrees again. Optional consent remains optional.</p>
    <form class="publish-notice" data-expected-version=""><h3>New purpose</h3>${noticeFields()}</form>
    ${consents.map(n=>`<form class="publish-notice" data-expected-version="${e(n.notice_version)}"><h3>${e(n.purpose)} · current ${e(n.notice_version)}</h3>${noticeFields(n)}</form>`).join('')}
    <h3>Recent publications</h3><ul>${publications.map(n=>`<li>${e(n.purpose)} · ${e(n.notice_version)} · ${e(n.published_at??'Imported; original date unknown')}<p>${e(n.notice_text??'Historic text unavailable or conflicting; consult consent snapshots.')}</p></li>`).join('')||'<li>No publications yet.</li>'}</ul></section>`;
  const domainAdmin=domains?`<section><h2>Custom domain ownership</h2><p>Verify DNS ownership here. HTTPS and domain activation are arranged separately.</p>
    <form id="domain-request"><label>Hostname<input name="hostname" maxlength="232" placeholder="learn.yourcompany.co.za" required></label><button>Create or replace DNS proof</button></form>
    <p id="domain-proof" role="status"></p><ul>${domains.claims.map(d=>`<li>${e(d.hostname)} · proof expires ${e(d.expires_at)} <button class="verify-domain" data-hostname="${e(d.hostname)}">Check DNS</button> <button class="remove-domain" data-hostname="${e(d.hostname)}">Remove</button></li>`).join('')}${domains.verified.map(d=>`<li>${e(d.hostname)} · ownership verified <button class="remove-domain" data-hostname="${e(d.hostname)}">Remove</button></li>`).join('')}</ul></section>`:'';
  const content=view==='organisations'?renderOrganisations({hub,account,organisation}):view==='create-hub'?`<h1>Create a learning hub</h1><form id="create-hub">
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
</style><script defer src="/assets/plinth-shell.js"></script></head>
<body data-hub-id="${e(hub.id)}" data-slug="${e(hub.slug)}" data-csrf="${e(csrfToken)}" data-org-id="${e(organisation?.organisation.id)}"><header><nav>
<a href="/h/${e(hub.slug)}">${e(hub.display_name)}</a><a href="/h/${e(hub.slug)}/member">Member area</a>
<a href="/h/${e(hub.slug)}/create-hub">Create a hub</a>
<a href="/h/${e(hub.slug)}/organisations">Organisations</a>
${membership && ['owner','admin'].includes(membership.role)?`<a href="/h/${e(hub.slug)}/admin">Hub admin</a>`:''}
<button type="button" id="logout">Sign out</button></nav></header><main>${content}<p id="status" role="status" aria-live="polite"></p></main></body></html>`;
}
