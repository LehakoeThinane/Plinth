import { escapeText as e } from './storefront.js';
export function renderLearning({hub,learning}) {
  const products=learning.products.map(p=>{
    const percent=p.total?Math.round(p.completed/p.total*100):0;
    const lessons=p.lessons.map(l=>`<li><a href="/h/${e(hub.slug)}/lessons/${e(l.id)}">${e(l.title)}</a>${l.completed?' · completed':''}</li>`).join('');
    return `<section><h2>${e(p.title)}</h2><p><progress max="${e(p.total)}" value="${e(p.completed)}"></progress> ${e(p.completed)} of ${e(p.total)} lessons completed (${percent}%)</p>
      ${p.next?`<p><a href="/h/${e(hub.slug)}/lessons/${e(p.next)}">${p.completed?'Continue':'Start'} learning</a></p>`:'<p>All lessons completed.</p>'}
      <details><summary>All lessons</summary><ol>${lessons}</ol></details></section>`;
  }).join('');
  return `<h1>My learning</h1>${products||`<p>You have no courses in this hub yet. <a href="/h/${e(hub.slug)}">Browse the shelf</a>.</p>`}`;
}
