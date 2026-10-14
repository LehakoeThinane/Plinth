import { escapeText as e,formatRand } from './storefront.js';
const types={course:'Course',toolkit:'Toolkit',programme:'Programme'};
const visibilities={public:'Public shelf',members:'Hub members only',company:'Private to one company'};
const modes={entitled:'Paid (buyers and seat holders)',members:'Free for hub members',open:'Free for everyone'};
const options=(labels,selected)=>Object.entries(labels).map(([value,label])=>`<option value="${value}"${value===selected?' selected':''}>${label}</option>`).join('');
const priceLabel=p=>formatRand(p.amount_cents)+({once_off:' once-off',per_seat:' per seat',subscription:p.billing_interval==='year'?' per year':' per month'})[p.model];
export function renderProducts({hub,products}) {
  const rows=products.map(p=>`<tr><td><a href="/h/${e(hub.slug)}/admin/products/${e(p.id)}">${e(p.title)}</a></td><td>${e(types[p.type]??p.type)}</td>
    <td>${e(visibilities[p.visibility]??p.visibility)}</td><td>${e(p.status)}</td><td>${e(p.lessons)}</td><td>${e(p.active_plans)}</td></tr>`).join('');
  return `<h1>Products</h1><section><h2>Your products</h2>${rows?`<table><thead><tr><th>Title</th><th>Type</th><th>Visibility</th><th>Status</th><th>Lessons</th><th>Active prices</th></tr></thead><tbody>${rows}</tbody></table>`:'<p>No products yet.</p>'}</section>
    <form id="create-product"><h2>Create a product</h2><p>Products start as drafts. Type and visibility cannot be changed later.</p>
    <label>Type<select name="type">${options(types,'course')}</select></label>
    <label>Title<input name="title" required maxlength="200"></label>
    <label>Summary<textarea name="summary" maxlength="2000"></textarea></label>
    <label>Visibility<select name="visibility">${options(visibilities,'public')}</select></label>
    <label>Company organisation ID <small>(only for company products)</small><input name="companyOrg" pattern="[0-9a-fA-F-]{36}"></label>
    <label>Access<select name="accessMode">${options(modes,'entitled')}</select></label>
    <button>Create draft</button></form>`;
}
export function renderProductEditor({hub,detail}) {
  const {product,modules,plans}=detail,live=product.status==='published',company=product.visibility==='company';
  const pending=modules.some(m=>m.lessons.some(l=>l.status==='draft'));
  const lessons=m=>m.lessons.map(l=>`<li>${e(l.title)} · ${e(l.status)}${l.preview_available?' · preview shown':''}
    <details><summary>Edit content${l.body?'':' (empty)'}</summary><form class="lesson-content" data-lesson-id="${e(l.id)}">
    <label>Lesson text <small>(plain text; a blank line starts a new paragraph)</small><textarea name="body" maxlength="50000" rows="12">${e(l.body)}</textarea></label>
    <button>Save content</button></form></details></li>`).join('');
  const outline=modules.map(m=>`<section><h3>${e(m.position+1)}. ${e(m.title)}</h3><ol>${lessons(m)}</ol>
    <form class="add-lesson" data-module-id="${e(m.id)}"><label>Lesson title<input name="title" required maxlength="200"></label>
    <label>Summary<textarea name="summary" maxlength="2000"></textarea></label>
    <label class="choice"><input type="checkbox" name="previewAvailable"><span>Show a locked preview (title and summary) to people who cannot open it yet</span></label><button>Add lesson</button></form></section>`).join('');
  const prices=plans.map(p=>`<li>${e(priceLabel(p))} · ${e(p.status)}${p.status==='active'?` <button type="button" class="retire-plan" data-plan-id="${e(p.id)}">Retire</button>`:''}</li>`).join('');
  return `<p><a href="/h/${e(hub.slug)}/admin/products">All products</a></p><h1>${e(product.title)}</h1>
    <p>${e(types[product.type]??product.type)} · ${e(visibilities[product.visibility]??product.visibility)} · ${e(product.status)}${live&&!company?` · <a href="/h/${e(hub.slug)}/products/${e(product.id)}">View public page</a>`:''}</p>
    ${company?`<p>Private to organisation <code>${e(product.company_org)}</code>. Access will come from seat grants; company products have no shelf prices.</p>`:''}
    <form id="product-details"><h2>Details</h2><label>Title<input name="title" required maxlength="200" value="${e(product.title)}"></label>
    <label>Summary<textarea name="summary" maxlength="2000">${e(product.summary)}</textarea></label>
    <label>Access<select name="accessMode"${live||company?' disabled':''}>${options(modes,product.access_mode)}</select></label>
    ${live?'<p>Access is fixed once published.</p>':''}<button>Save details</button></form>
    <section><h2>Outline</h2>${outline||'<p>No modules yet.</p>'}
    <form id="add-module"><label>Module title<input name="title" required maxlength="200"></label><button>Add module</button></form></section>
    ${company?'':`<section><h2>Prices</h2><p>Prices cannot be edited. To change one, add the new price and retire the old one. A live paid product keeps at least one active price.</p>
    <ul>${prices||'<li>No prices yet.</li>'}</ul>
    <form id="add-plan"><label>Model<select name="model"><option value="once_off">Once-off</option><option value="subscription">Subscription</option><option value="per_seat">Per seat</option></select></label>
    <label>Amount in rand<input name="amount" inputmode="decimal" required pattern="[0-9]+([.,][0-9]{1,2})?" placeholder="1250.00"></label>
    <label>Billing period <small>(subscriptions only)</small><select name="interval"><option value="month">Monthly</option><option value="year">Yearly</option></select></label>
    <button>Add price</button></form></section>`}
    <section><h2>Publishing</h2><p>${live?(pending?'Some lessons are still drafts.':'This product is live.'):'Publishing needs at least one lesson'+(company||product.access_mode!=='entitled'?'.':' and an active price.')} Published products cannot be withdrawn yet.</p>
    ${!live||pending?`<button type="button" id="publish-product">${live?'Publish new lessons':'Publish product'}</button>`:''}</section>`;
}
