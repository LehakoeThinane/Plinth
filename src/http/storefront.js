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
function layout(hub,{signIn,title,main,session=null,data={}}) {
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
</style>${session?'<script defer src="/assets/plinth-shell.js"></script>':''}</head>
<body${session?` data-hub-id="${e(session.hubId)}" data-slug="${e(hub.slug)}" data-csrf="${e(session.csrfToken)}"`+Object.entries(data).map(([k,v])=>` data-${k}="${e(v)}"`).join(''):''}>
<header><div class="wrap"><a href="/h/${e(hub.slug)}">${logo}</a><strong>${e(hub.display_name)}</strong><a href="/h/${e(hub.slug)}/library">Library</a><a href="/h/${e(hub.slug)}/membership">Membership</a><a href="/h/${e(hub.slug)}/enquiries">Enquire about bespoke work</a>${session?`<a href="/h/${e(hub.slug)}/learning">My learning</a>`:signIn?`<a href="/h/${e(hub.slug)}/sign-in">Sign in</a><a href="/h/${e(hub.slug)}/sign-in?view=join">Join hub</a>`:''}</div></header>
<main class="wrap">${main}<p id="status" role="status" aria-live="polite"></p></main><footer class="wrap">Powered by Plinth</footer></body></html>`;
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
/** Plain text only: blank lines separate paragraphs, single newlines break lines. */
export function renderBody(body) {
  return String(body??'').split(/\r?\n\s*\r?\n/).map(p=>p.trim()).filter(Boolean)
    .map(p=>'<p>'+e(p).replace(/\r?\n/g,'<br>')+'</p>').join('');
}
export function renderProductPage(hub,{product,modules,plans},{signIn=false}={}) {
  // Link a lesson where a visitor can see something: free products, or lessons with a preview.
  const lessonItem=l=>{
    const linked=product.access_mode==='open'||l.preview_available;
    const title=linked?`<a href="/h/${e(hub.slug)}/lessons/${e(l.id)}">${e(l.title)}</a>`:e(l.title);
    return `<li>${title}${l.preview_available&&product.access_mode!=='open'?' · preview':''}</li>`;
  };
  const outline=modules.map(m=>`<li><strong>${e(m.title)}</strong><ol>${m.lessons.map(lessonItem).join('')}</ol></li>`).join('');
  const pricing=product.access_mode==='entitled'?(plans.length?`<ul>${plans.map(p=>`<li class="price">${e(priceLabel(p))} ${p.model==='once_off'?`<a href="/h/${e(hub.slug)}/checkout/${e(product.id)}/${e(p.id)}">Buy now</a>`:'· opening soon'}</li>`).join('')}</ul>`:'<p>Not currently on sale.</p>')
    :`<p class="price">${product.access_mode==='members'?'Free for hub members':'Free'}</p>`;
  return layout(hub,{signIn,title:product.title+' · '+hub.display_name,main:`<section class="intro"><p class="eyebrow">${e(typeLabels[product.type]??'Course')}</p>
<h1>${e(product.title)}</h1><p class="description">${e(product.summary)}</p></section>
<section class="card"><h2>Pricing</h2>${pricing}</section>
<section class="card"><h2>What's inside</h2>${outline?`<ol>${outline}</ol>`:'<p>The outline will appear here.</p>'}</section>`});
}
const unlock={join:'Join this hub to open this lesson.',purchase:'Buy this product to open this lesson.'};
export function renderLessonPage(hub,{decision,reason,lesson},{signIn=false,session=null}={}) {
  // Text lessons record position as a fraction: 1 means read to the end.
  const progress=decision==='allowed'&&session?`<section class="card"><h2>Your progress</h2>${lesson.progress?.completed?'<p>Completed.</p>':
    '<button type="button" id="complete-lesson">Mark as complete</button>'}<p><a href="/h/${e(hub.slug)}/learning">My learning</a></p></section>`:'';
  const page=lessonLayout(hub,{decision,reason,lesson,signIn});
  return decision==='allowed'&&session?layout(hub,{signIn,session,title:page.title,main:page.main+progress,
    data:{'lesson-id':lesson.id,'revision':lesson.progress?.revision??0}}):layout(hub,{signIn,title:page.title,main:page.main});
}
function lessonLayout(hub,{decision,reason,lesson}) {
  const back=`<p><a href="/h/${e(hub.slug)}/products/${e(lesson.productId)}">${e(lesson.productTitle)}</a></p>`;
  const locked=`<section class="card"><h2>Locked</h2><p>${e(unlock[reason]??'This lesson is not available to you yet.')}</p>
    <p>${reason==='join'?`<a href="/h/${e(hub.slug)}/sign-in?view=join">Join the hub</a>`:`<a href="/h/${e(hub.slug)}/products/${e(lesson.productId)}">See pricing</a>`}</p></section>`;
  return {title:lesson.title+' · '+hub.display_name,main:`<section class="intro">${back}<h1>${e(lesson.title)}</h1>
<p class="description">${e(lesson.summary)}</p></section>
${decision==='allowed'?`<article class="card lesson">${renderBody(lesson.body)||'<p>This lesson has no written content yet.</p>'}</article>`:locked}`};
}
const visibilityLabels={public:'Free to read',members:'For hub members',tier:'For membership tiers',entitled:'For buyers'};
const itemLabel=i=>i.visibility==='entitled'&&i.product_title?'For buyers of '+i.product_title:visibilityLabels[i.visibility]??'';
export function renderLibrary(hub,{items,next},{signIn=false,topic=null}={}) {
  const base='/h/'+e(hub.slug)+'/library';
  const list=items.map(i=>`<li><p class="eyebrow">${e(itemLabel(i))}</p><h3><a href="${base}/${e(i.id)}">${e(i.title)}</a></h3><p>${e(i.summary)}</p>
    <p>${i.topics.map(t=>`<a href="${base}?topic=${e(t)}">#${e(t)}</a>`).join(' ')}</p></li>`).join('');
  const more=next?`<p><a href="${base}?${topic?'topic='+e(topic)+'&amp;':''}before=${e(encodeURIComponent(next))}">Older items</a></p>`:'';
  return layout(hub,{signIn,title:'Library · '+hub.display_name,main:`<section class="intro"><p class="eyebrow">Library</p><h1>${topic?'#'+e(topic):'Articles and resources'}</h1>
${topic?`<p><a href="${base}">All topics</a></p>`:''}</section>
<section class="card">${list?`<ul class="shelf">${list}</ul>${more}`:'<p>Nothing has been published here yet.</p>'}</section>`});
}
const libraryUnlock={join:'Join this hub to read this item.',tier:'This item is included in a membership tier.',purchase:'This item is included with a product purchase.'};
export function renderLibraryItem(hub,{decision,reason,item},{signIn=false}={}) {
  const action=reason==='join'?`<a href="/h/${e(hub.slug)}/sign-in?view=join">Join the hub</a>`:
    reason==='purchase'&&item.requiredProductId?`<a href="/h/${e(hub.slug)}/products/${e(item.requiredProductId)}">See ${e(item.productTitle)}</a>`:'';
  const locked=`<section class="card"><h2>Locked</h2><p>${e(libraryUnlock[reason]??'This item is not available to you yet.')}</p>${action?`<p>${action}</p>`:''}</section>`;
  return layout(hub,{signIn,title:item.title+' · '+hub.display_name,main:`<section class="intro"><p><a href="/h/${e(hub.slug)}/library">Library</a></p>
<p class="eyebrow">${e(itemLabel({...item,product_title:item.productTitle}))}</p><h1>${e(item.title)}</h1><p class="description">${e(item.summary)}</p></section>
${decision==='allowed'?`<article class="card">${renderBody(item.body)||'<p>This item has no text yet.</p>'}</article>`:locked}`});
}
const benefitLabels={product:'Course',space:'Community space',library:'Library'};
export function renderMembership(hub,{tiers},{signIn=false}={}) {
  const cards=tiers.map(t=>`<li><p class="eyebrow">Tier ${e(t.rank)}</p><h3>${e(t.name)}</h3>
    <p class="price">${e(formatRand(t.amount_cents))} per ${t.billing_interval==='year'?'year':'month'}</p><p>${e(t.description)}</p>
    <ul>${t.benefits.map(b=>`<li>${e(benefitLabels[b.target_type]??'')}: ${e(b.title)}</li>`).join('')||'<li>Benefits are being added.</li>'}</ul></li>`).join('');
  return layout(hub,{signIn,title:'Membership · '+hub.display_name,main:`<section class="intro"><p class="eyebrow">Membership</p><h1>Choose how you take part</h1>
<p class="description">Every member can join the hub for free. Tiers add courses, spaces and library items.</p></section>
<section class="card">${cards?`<ul class="shelf">${cards}</ul><p>Subscriptions open soon.</p>`:'<p>This hub does not offer membership tiers.</p>'}</section>`});
}