import { escapeText as e } from './storefront.js';
export function renderLearning({hub,learning}) {
  const products=learning.products.map(p=>{
    const percent=p.total?Math.round(p.completed/p.total*100):0;
    const lessons=p.lessons.map(l=>`<li><a href="/h/${e(hub.slug)}/lessons/${e(l.id)}">${e(l.title)}</a>${l.completed?' <span class="done">Completed</span>':''}</li>`).join('');
    return `<section class="course"><div class="section-head"><h2>${e(p.title)}</h2><span class="count">${percent}%</span></div>
      <progress max="${e(p.total)}" value="${e(p.completed)}" aria-label="${e(p.title)} progress"></progress><p class="count">${e(p.completed)} of ${e(p.total)} lessons completed</p>
      ${p.next?`<p class="actions"><a class="button primary" href="/h/${e(hub.slug)}/lessons/${e(p.next)}">${p.completed?'Continue':'Start'} learning</a></p>`:'<p class="done">All lessons completed.</p>'}
      <details><summary>All lessons</summary><ol>${lessons}</ol></details></section>`;
  }).join('');
  return `<h1>My learning</h1>${products||`<p>You have no courses in this hub yet. <a href="/h/${e(hub.slug)}">Browse the shelf</a>.</p>`}`;
}
