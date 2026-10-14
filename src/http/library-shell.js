import { escapeText as e } from './storefront.js';
import { badge } from './ui.js';
const visibilities={public:'Free to read (public)',members:'Hub members',tier:'Membership tiers that include it',entitled:'Buyers of a product'};
const options=(labels,selected)=>Object.entries(labels).map(([value,label])=>`<option value="${value}"${value===selected?' selected':''}>${label}</option>`).join('');
function itemFields(item={},products=[]) {
  const paid=products.filter(p=>p.access_mode==='entitled'&&p.visibility!=='company');
  return `<label>Title<input name="title" required maxlength="200" value="${e(item.title)}"></label>
    <label>Summary <small>(shown to everyone, including in locked previews)</small><textarea name="summary" maxlength="2000">${e(item.summary)}</textarea></label>
    <label>Text <small>(plain text; a blank line starts a new paragraph)</small><textarea name="body" maxlength="50000" rows="14">${e(item.body)}</textarea></label>
    <label>Who can read it<select name="visibility">${options(visibilities,item.visibility??'public')}</select></label>
    <label>Product <small>(only when readers must be buyers)</small><select name="requiredProductId"><option value="">None</option>${paid.map(p=>`<option value="${e(p.id)}"${p.id===item.required_product_id?' selected':''}>${e(p.title)}</option>`).join('')}</select></label>
    <label>Topics <small>(up to 5, comma separated, lowercase words with hyphens)</small><input name="topics" maxlength="220" value="${e((item.topics??[]).join(', '))}"></label>`;
}
export function renderLibraryAdmin({hub,items}) {
  const rows=items.map(i=>`<tr><td><a href="/h/${e(hub.slug)}/admin/library/${e(i.id)}">${e(i.title)}</a></td><td>${e(visibilities[i.visibility]??i.visibility)}</td>
    <td>${badge(i.status)}</td><td>${e((i.topics??[]).join(', '))}</td></tr>`).join('');
  return `<h1>Library</h1><p class="muted">Articles for the public, members, tiers or buyers.</p><section><h2>Your items</h2>${rows?`<div class="table"><table><thead><tr><th>Title</th><th>Readers</th><th>Status</th><th>Topics</th></tr></thead><tbody>${rows}</tbody></table></div>`:'<p class="muted">No library items yet.</p>'}</section>
    <form id="create-library-item"><h2>Write an article</h2><p class="muted">Items start as drafts. Podcasts and videos arrive with media uploads.</p>${itemFields()}<button>Create draft</button></form>`;
}
export function renderLibraryEditor({hub,item,products}) {
  return `<p class="crumb"><a href="/h/${e(hub.slug)}/admin/library">All library items</a></p><h1>${e(item.title)}</h1>
    <p class="meta">${badge(item.status)}${item.status==='published'?`<a href="/h/${e(hub.slug)}/library/${e(item.id)}">View public page</a>`:''}</p>
    <form id="library-item" data-item-id="${e(item.id)}"><h2>Edit</h2>${itemFields(item,products)}<button>Save item</button></form>
    <section><h2>Publishing</h2><p class="muted">Published items appear in the hub library; readers who cannot open them see a locked preview. Archived items are hidden and cannot return to draft.</p>
    <p class="actions">${item.status!=='published'?'<button type="button" class="library-status" data-action="publish">Publish</button>':''}
    ${item.status!=='archived'?'<button type="button" class="library-status" data-action="archive">Archive</button>':''}</p></section>`;
}
