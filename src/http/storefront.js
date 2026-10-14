import { escapeText,head } from './ui.js';
export { escapeText };
const e=escapeText;
/** Formats integer cents as South African rand, e.g. R1 250.00. */
export function formatRand(cents) {
  const value=Number(cents),whole=Math.floor(value/100).toString().replace(/\B(?=(\d{3})+(?!\d))/g,' ');
  return 'R'+whole+'.'+String(value%100).padStart(2,'0');
}
const typeLabels={course:'Course',toolkit:'Toolkit',programme:'Programme'};
const priceLabel=plan=>formatRand(plan.amount_cents)+({once_off:'',per_seat:' per seat',subscription:plan.billing_interval==='year'?' per year':' per month'})[plan.model];
const logoFor=hub=>typeof hub.logo_path==='string' &&
  new RegExp('^/assets/hubs/'+hub.id+'/branding/[a-zA-Z0-9_-]+\\.(png|jpg|webp)$').test(hub.logo_path)?
  '<img src="'+e(hub.logo_path)+'" alt="">':'';
/** The hub's own bar: its name and logo lead; the platform only appears in the footer. */
export function hubBar(hub,links) {
  return `<a class="skip" href="#main">Skip to content</a><header class="hubbar"><div class="wrap">
<a class="hubname" href="/h/${e(hub.slug)}">${logoFor(hub)}<span>${e(hub.display_name)}</span></a>
<nav class="nav" aria-label="${e(hub.display_name)}">${links}</nav></div></header>`;
}
export function plinthFooter(hub) {
  return `<footer class="plinth"><div class="wrap"><span>${e(hub.display_name)} · prices in South African rand</span><strong>Powered by Plinth</strong></div></footer>`;
}
const navLink=(href,label,current)=>`<a href="${href}"${current?' aria-current="page"':''}>${label}</a>`;
function layout(hub,{signIn,title,main,session=null,data={},current=null,hero=''}) {
  const base='/h/'+e(hub.slug);
  const links=navLink(base,'Courses',current==='shelf')+navLink(base+'/library','Library',current==='library')+
    navLink(base+'/membership','Membership',current==='membership')+navLink(base+'/enquiries','Enquire about bespoke work',false)+
    (session?navLink(base+'/learning','My learning',false):signIn?navLink(base+'/sign-in','Sign in',false)+`<a class="button primary" href="${base}/sign-in?view=join">Join hub</a>`:'');
  return `${head({title,hub,script:Boolean(session)})}
<body${session?` data-hub-id="${e(session.hubId)}" data-slug="${e(hub.slug)}" data-csrf="${e(session.csrfToken)}"`+Object.entries(data).map(([k,v])=>` data-${k}="${e(v)}"`).join(''):''}>
${hubBar(hub,links)}${hero}
<main id="main"><div class="wrap page">${main}<p id="status" role="status" aria-live="polite"></p></div></main>${plinthFooter(hub)}</body></html>`;
}
const accessLabel=p=>p.access_mode==='entitled'?'Paid':p.access_mode==='members'?'Members':'Free';
export function renderStorefront(hub,{signIn=false,products=null}={}) {
  const base='/h/'+e(hub.slug);
  const items=(products??[]).map(p=>`<li class="placard"><div class="label-top"><span class="eyebrow">${e(typeLabels[p.type]??'Course')}</span><span class="eyebrow">${accessLabel(p)}</span></div>
    <div class="body"><h3><a href="${base}/products/${e(p.id)}">${e(p.title)}</a></h3><p class="muted">${e(p.summary)}</p></div>
    <div class="foot"><span class="price">${p.access_mode==='entitled'?(p.from_cents==null?'':'From '+formatRand(p.from_cents)):p.access_mode==='members'?'Free for members':'Free'}</span><span class="more">See the outline</span></div></li>`).join('');
  const hero=`<section class="masthead"><div class="wrap"><p class="eyebrow">Learning &amp; knowledge exchange</p>
<h1>${e(hub.display_name)}</h1>
<p class="lede">${e(hub.description||'A place to learn, connect, and exchange ideas.')}</p>
<div class="actions"><a class="button" href="#courses">Browse courses</a>${signIn?`<a class="button ghost" href="${base}/sign-in?view=join">Join the hub</a>`:''}</div></div></section>`;
  return layout(hub,{signIn,title:hub.display_name,current:'shelf',hero,main:`<section class="shelf-section" aria-labelledby="courses">
<div class="section-head"><h2 id="courses">Courses and programmes</h2>${products?.length?`<span class="muted">${products.length} available</span>`:''}</div>
${items?`<ul class="shelf">${items}</ul>`:'<p class="muted">New courses will appear here as they are published.</p>'}</section>`});
}
/** Plain text only: blank lines separate paragraphs, single newlines break lines. */
export function renderBody(body) {
  return String(body??'').split(/\r?\n\s*\r?\n/).map(p=>p.trim()).filter(Boolean)
    .map(p=>'<p>'+e(p).replace(/\r?\n/g,'<br>')+'</p>').join('');
}
export function renderProductPage(hub,{product,modules,plans},{signIn=false}={}) {
  const base='/h/'+e(hub.slug);
  // Link a lesson where a visitor can see something: free products, or lessons with a preview.
  const lessonItem=l=>{
    const linked=product.access_mode==='open'||l.preview_available;
    const title=linked?`<a href="${base}/lessons/${e(l.id)}">${e(l.title)}</a>`:`<span>${e(l.title)}</span>`;
    return `<li>${title}${l.preview_available&&product.access_mode!=='open'?'<span class="tag">Preview</span>':''}</li>`;
  };
  const lessonCount=modules.reduce((n,m)=>n+m.lessons.length,0);
  const outline=modules.map(m=>`<li><h3>${e(m.title)}</h3><ol>${m.lessons.map(lessonItem).join('')}</ol></li>`).join('');
  const pricing=product.access_mode==='entitled'?(plans.length?`<ul class="plans">${plans.map(p=>`<li><span class="eyebrow">${({once_off:'Once-off',subscription:'Subscription',per_seat:'For companies'})[p.model]}</span>
      <span class="price">${e(priceLabel(p))}</span>${p.model==='per_seat'?'<span class="muted">Company seats are opening soon.</span>':
      `<a class="button primary" href="${base}/checkout/${e(product.id)}/${e(p.id)}">${p.model==='subscription'?'Subscribe':'Buy now'}</a>`}</li>`).join('')}</ul>`:'<p class="muted">Not currently on sale.</p>')
    :`<p class="price">${product.access_mode==='members'?'Free for hub members':'Free'}</p>${product.access_mode==='members'&&signIn?`<a class="button primary" href="${base}/sign-in?view=join">Join the hub</a>`:''}`;
  return layout(hub,{signIn,title:product.title+' · '+hub.display_name,current:'shelf',main:`<p class="crumb"><a href="${base}">All courses</a></p>
<section class="intro"><p class="eyebrow">${e(typeLabels[product.type]??'Course')}</p><h1>${e(product.title)}</h1><p class="lede">${e(product.summary)}</p></section>
<div class="split"><div class="content"><section><h2>What's inside</h2>${outline?`<ol class="outline">${outline}</ol>`:'<p class="muted">The outline will appear here.</p>'}</section></div>
<aside class="aside content"><section><h2>Pricing</h2>${pricing}
<dl class="facts"><dt>Modules</dt><dd>${modules.length}</dd><dt>Lessons</dt><dd>${lessonCount}</dd><dt>Access</dt><dd>${e(accessLabel(product))}</dd></dl></section></aside></div>`});
}
const unlock={join:'Join this hub to open this lesson.',purchase:'Buy this product to open this lesson.'};
export function renderLessonPage(hub,{decision,reason,lesson},{signIn=false,session=null}={}) {
  // Text lessons record position as a fraction: 1 means read to the end.
  const progress=decision==='allowed'&&session?`<section class="panel"><h2>Your progress</h2>${lesson.progress?.completed?'<p class="done">Completed.</p>':
    '<div class="actions"><button type="button" id="complete-lesson">Mark as complete</button></div>'}<p><a href="/h/${e(hub.slug)}/learning">Back to My learning</a></p></section>`:'';
  const page=lessonLayout(hub,{decision,reason,lesson,signIn});
  return decision==='allowed'&&session?layout(hub,{signIn,session,title:page.title,main:page.main.replace('<!--progress-->',progress),
    data:{'lesson-id':lesson.id,'revision':lesson.progress?.revision??0}}):layout(hub,{signIn,title:page.title,main:page.main});
}
function lessonLayout(hub,{decision,reason,lesson}) {
  const back=`<p class="crumb"><a href="/h/${e(hub.slug)}/products/${e(lesson.productId)}">${e(lesson.productTitle)}</a></p>`;
  const locked=`<section class="locked"><h2>Locked</h2><p>${e(unlock[reason]??'This lesson is not available to you yet.')}</p>
    <p>${reason==='join'?`<a class="button primary" href="/h/${e(hub.slug)}/sign-in?view=join">Join the hub</a>`:`<a class="button primary" href="/h/${e(hub.slug)}/products/${e(lesson.productId)}">See pricing</a>`}</p></section>`;
  return {title:lesson.title+' · '+hub.display_name,main:`<div class="reading">${back}<section class="intro"><p class="eyebrow">Lesson</p><h1>${e(lesson.title)}</h1>
${lesson.summary?`<p class="lede">${e(lesson.summary)}</p>`:''}</section>
<div class="content">${decision==='allowed'?`<article class="prose">${renderBody(lesson.body)||'<p>This lesson has no written content yet.</p>'}</article>`:locked}<!--progress--></div></div>`};
}
const visibilityLabels={public:'Free to read',members:'For hub members',tier:'For membership tiers',entitled:'For buyers'};
const itemLabel=i=>i.visibility==='entitled'&&i.product_title?'For buyers of '+i.product_title:visibilityLabels[i.visibility]??'';
export function renderLibrary(hub,{items,next},{signIn=false,topic=null}={}) {
  const base='/h/'+e(hub.slug)+'/library';
  const list=items.map(i=>`<li><p class="eyebrow">${e(itemLabel(i))}</p><h3><a href="${base}/${e(i.id)}">${e(i.title)}</a></h3><p class="muted">${e(i.summary)}</p>
    ${i.topics.length?`<p class="topics">${i.topics.map(t=>`<a href="${base}?topic=${e(t)}">#${e(t)}</a>`).join(' ')}</p>`:''}</li>`).join('');
  const more=next?`<p><a href="${base}?${topic?'topic='+e(topic)+'&amp;':''}before=${e(encodeURIComponent(next))}">Older items</a></p>`:'';
  return layout(hub,{signIn,title:'Library · '+hub.display_name,current:'library',main:`<section class="intro"><p class="eyebrow">Library</p><h1>${topic?'#'+e(topic):'Articles and resources'}</h1>
${topic?`<p class="crumb"><a href="${base}">All topics</a></p>`:''}</section>
<div class="content"><section>${list?`<ul class="rows">${list}</ul>${more}`:'<p class="muted">Nothing has been published here yet.</p>'}</section></div>`});
}
const libraryUnlock={join:'Join this hub to read this item.',tier:'This item is included in a membership tier.',purchase:'This item is included with a product purchase.'};
export function renderLibraryItem(hub,{decision,reason,item},{signIn=false}={}) {
  const action=reason==='join'?`<a class="button primary" href="/h/${e(hub.slug)}/sign-in?view=join">Join the hub</a>`:
    reason==='tier'?`<a class="button primary" href="/h/${e(hub.slug)}/membership">See membership tiers</a>`:
    reason==='purchase'&&item.requiredProductId?`<a class="button primary" href="/h/${e(hub.slug)}/products/${e(item.requiredProductId)}">See ${e(item.productTitle)}</a>`:'';
  const locked=`<section class="locked"><h2>Locked</h2><p>${e(libraryUnlock[reason]??'This item is not available to you yet.')}</p>${action?`<p>${action}</p>`:''}</section>`;
  return layout(hub,{signIn,title:item.title+' · '+hub.display_name,current:'library',main:`<div class="reading"><p class="crumb"><a href="/h/${e(hub.slug)}/library">Library</a></p>
<section class="intro"><p class="eyebrow">${e(itemLabel({...item,product_title:item.productTitle}))}</p><h1>${e(item.title)}</h1>${item.summary&&item.summary!==item.title?`<p class="lede">${e(item.summary)}</p>`:''}</section>
<div class="content">${decision==='allowed'?`<article class="prose">${renderBody(item.body)||'<p>This item has no text yet.</p>'}</article>`:locked}</div></div>`});
}
const benefitLabels={product:'Course',space:'Community space',library:'Library'};
export function renderMembership(hub,{tiers},{signIn=false}={}) {
  const cards=tiers.map(t=>`<li class="placard"><div class="label-top"><span class="eyebrow">Tier ${e(t.rank)}</span><span class="eyebrow">${t.benefits.length} benefit${t.benefits.length===1?'':'s'}</span></div>
    <div class="body"><h3>${e(t.name)}</h3><p class="price">${e(formatRand(t.amount_cents))} <small>per ${t.billing_interval==='year'?'year':'month'}</small></p><p class="muted">${e(t.description)}</p>
    <ul>${t.benefits.map(b=>`<li>${e(benefitLabels[b.target_type]??'')}: ${e(b.title)}</li>`).join('')||'<li>Benefits are being added.</li>'}</ul></div>
    <div class="foot"><a class="button primary" href="/h/${e(hub.slug)}/subscribe/${e(t.id)}">Subscribe</a></div></li>`).join('');
  return layout(hub,{signIn,title:'Membership · '+hub.display_name,current:'membership',main:`<section class="intro"><p class="eyebrow">Membership</p><h1>Choose how you take part</h1>
<p class="lede">Every member can join the hub for free. Tiers add courses, spaces and library items.</p></section>
${cards?`<ul class="shelf tiers">${cards}</ul><p class="muted">Cancel any time; access continues until the end of the paid period.</p>`:'<p class="muted">This hub does not offer membership tiers.</p>'}`});
}
