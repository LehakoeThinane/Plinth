export function escapeText(value) {
  return String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[char]);
}
const e=escapeText;
/** Formats integer cents as South African rand, e.g. R1 250.00. */
export function formatRand(cents) {
  const value=Number(cents),whole=Math.floor(value/100).toString().replace(/\B(?=(\d{3})+(?!\d))/g,' ');
  return 'R'+whole+'.'+String(value%100).padStart(2,'0');
}
const typeLabels={course:'Course',toolkit:'Toolkit',programme:'Programme'};
const priceLabel=plan=>formatRand(plan.amount_cents)+({once_off:'',per_seat:' per seat',subscription:plan.billing_interval==='year'?' per year':' per month'})[plan.model];
function layout(hub,{signIn,title,main}) {
  const color=/^#[0-9a-f]{6}$/i.test(hub.primary_color)?hub.primary_color:'#2456A6';
  const font=({system:'system-ui, sans-serif',serif:'Georgia, serif',sans:'Arial, sans-serif'})[hub.font]??'system-ui, sans-serif';
  const logo=typeof hub.logo_path==='string' &&
    new RegExp('^/assets/hubs/'+hub.id+'/branding/[a-zA-Z0-9_-]+\\.(png|jpg|webp)$').test(hub.logo_path)?
    '<img class="logo" src="'+e(hub.logo_path)+'" alt="">':'';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(title)}</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#f6f7fa;color:#172334;font-family:${font};line-height:1.6}
header{background:white;border-top:6px solid ${color};border-bottom:1px solid #dce2ea}
.wrap{max-width:1000px;margin:auto;padding:24px}header .wrap{display:flex;align-items:center;gap:16px;flex-wrap:wrap}
.logo{max-width:64px;max-height:64px}h1{font-size:clamp(2rem,5vw,3.25rem);line-height:1.15;margin:20px 0}
.eyebrow{font-size:.85rem;letter-spacing:.08em;text-transform:uppercase;color:#44556b}
.intro{max-width:680px;padding-top:48px;padding-bottom:40px}.description{white-space:pre-wrap;font-size:1.1rem}
.card{background:white;padding:28px;border:1px solid #dce2ea;border-radius:12px;margin-bottom:40px}
.shelf{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:20px;list-style:none;padding:0}
.shelf li{border:1px solid #dce2ea;border-radius:10px;padding:20px}.price{font-weight:600}
a{color:${color}}h2{margin-top:0}footer{color:#44556b;font-size:.9rem}
</style></head><body>
<header><div class="wrap"><a href="/h/${e(hub.slug)}">${logo}</a><strong>${e(hub.display_name)}</strong>${signIn?`<a href="/h/${e(hub.slug)}/sign-in">Sign in</a><a href="/h/${e(hub.slug)}/sign-in?view=join">Join hub</a>`:''}</div></header>
<main class="wrap">${main}</main><footer class="wrap">Powered by Plinth</footer></body></html>`;
}
export function renderStorefront(hub,{signIn=false,products=null}={}) {
  const items=(products??[]).map(p=>`<li><p class="eyebrow">${e(typeLabels[p.type]??'Course')}</p>
    <h3><a href="/h/${e(hub.slug)}/products/${e(p.id)}">${e(p.title)}</a></h3><p>${e(p.summary)}</p>
    <p class="price">${p.access_mode==='entitled'?(p.from_cents==null?'':'From '+formatRand(p.from_cents)):p.access_mode==='members'?'Free for members':'Free'}</p></li>`).join('');
  return layout(hub,{signIn,title:hub.display_name,main:`<section class="intro"><p class="eyebrow">Learning &amp; knowledge exchange</p>
<h1>${e(hub.display_name)}</h1>
<p class="description">${e(hub.description||'A place to learn, connect, and exchange ideas.')}</p></section>
<section class="card" aria-labelledby="courses"><h2 id="courses">Explore courses</h2>${items?`<ul class="shelf">${items}</ul>`:'<p>New courses will appear here as they are published.</p>'}</section>`});
}
export function renderProductPage(hub,{product,modules,plans},{signIn=false}={}) {
  const outline=modules.map(m=>`<li><strong>${e(m.title)}</strong><ol>${m.lessons.map(l=>`<li>${e(l.title)}${l.preview_available?' · free preview':''}</li>`).join('')}</ol></li>`).join('');
  const pricing=product.access_mode==='entitled'?(plans.length?`<ul>${plans.map(p=>`<li class="price">${e(priceLabel(p))}</li>`).join('')}</ul><p>Purchasing opens soon.</p>`:'<p>Not currently on sale.</p>')
    :`<p class="price">${product.access_mode==='members'?'Free for hub members':'Free'}</p>`;
  return layout(hub,{signIn,title:product.title+' · '+hub.display_name,main:`<section class="intro"><p class="eyebrow">${e(typeLabels[product.type]??'Course')}</p>
<h1>${e(product.title)}</h1><p class="description">${e(product.summary)}</p></section>
<section class="card"><h2>Pricing</h2>${pricing}</section>
<section class="card"><h2>What's inside</h2>${outline?`<ol>${outline}</ol>`:'<p>The outline will appear here.</p>'}</section>`});
}
