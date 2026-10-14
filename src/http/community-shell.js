import { escapeText as e,renderBody } from './storefront.js';
import { when,badge } from './ui.js';
const kinds={like:'Like',insightful:'Insightful',thanks:'Thanks'};
const visibilities={hub:'Everyone in the hub',tier:'Membership tier',company:'Private to one company'};
// Hub profiles are not built yet: authors show as "You" or a short account reference.
const author=(id,userId)=>id===userId?'You':'Member '+String(id).slice(0,8);
function reactions(post) {
  return Object.entries(kinds).map(([kind,label])=>{
    const on=(post.mine??[]).includes(kind),count=post.reactions?.[kind]??0;
    return `<button type="button" class="react" data-post-id="${e(post.id)}" data-kind="${kind}" data-on="${on?'false':'true'}" aria-pressed="${on}">${label}${count?' '+count:''}</button>`;
  }).join('');
}
function actions(type,item,userId) {
  return `${item.author_id===userId?`<button type="button" class="withdraw" data-type="${type}" data-id="${e(item.id)}">Delete</button>`:''}
    <button type="button" class="report" data-type="${type}" data-id="${e(item.id)}">Report</button>`;
}
export function renderCommunity({hub,spaces}) {
  const list=spaces.map(s=>`<li><h3>${s.decision==='allowed'?`<a href="/h/${e(hub.slug)}/community/spaces/${e(s.id)}">${e(s.title)}</a>`:e(s.title)}</h3>
    <p class="meta"><span>${e(visibilities[s.visibility]??s.visibility)}</span>${s.decision==='locked'?`<span class="tag">Included in a membership tier</span>`:''}${s.status==='archived'?badge('archived'):''}</p><p class="muted">${e(s.description)}</p></li>`).join('');
  return `<h1>Community</h1><p class="muted">Spaces for members of ${e(hub.display_name)} to talk, ask and share.</p><section><ul class="rows">${list||'<li class="muted">No spaces yet.</li>'}</ul></section>`;
}
export function renderSpace({hub,space,feed,userId}) {
  if(feed.decision==='locked')return `<p class="crumb"><a href="/h/${e(hub.slug)}/community">All spaces</a></p><h1>${e(space.title)}</h1><p class="lede">${e(space.description)}</p>
    <div class="locked"><h2>Locked</h2><p>This space is included in a membership tier.</p><p><a class="button primary" href="/h/${e(hub.slug)}/membership">See membership tiers</a></p></div>`;
  const posts=feed.posts.map(p=>`<article class="post"><p class="byline"><strong>${e(author(p.author_id,userId))}</strong>${when(p.created_at)}</p>${renderBody(p.body)}
    <div class="actions">${reactions(p)}<a href="/h/${e(hub.slug)}/community/posts/${e(p.id)}">${p.comments} comment${p.comments===1?'':'s'}</a>${actions('post',p,userId)}</div></article>`).join('');
  return `<p class="crumb"><a href="/h/${e(hub.slug)}/community">All spaces</a></p><h1>${e(space.title)}</h1><p class="lede">${e(space.description)}</p>
    ${space.status==='active'?`<form id="create-post" data-space-id="${e(space.id)}"><label>Start a post<textarea name="body" required maxlength="10000" placeholder="Share a win, ask a question or post a practice clip link"></textarea></label><button>Post</button></form>`:'<p class="muted">This space is archived and read-only.</p>'}
    <div class="feed">${posts||'<p class="muted">No posts yet. Start the conversation.</p>'}${feed.next?`<p><a href="/h/${e(hub.slug)}/community/spaces/${e(space.id)}?before=${e(encodeURIComponent(feed.next))}">Older posts</a></p>`:''}</div>`;
}
export function renderPostPage({hub,thread,userId}) {
  const {post,comments}=thread;
  const list=comments.map(c=>`<li><p class="byline"><strong>${e(author(c.author_id,userId))}</strong>${when(c.created_at)}</p>${renderBody(c.body)}<div class="actions">${actions('comment',c,userId)}</div></li>`).join('');
  return `<p class="crumb"><a href="/h/${e(hub.slug)}/community/spaces/${e(post.space_id)}">Back to the space</a></p>
    <article class="post"><p class="byline"><strong>${e(author(post.author_id,userId))}</strong>${when(post.created_at)}</p>${renderBody(post.body)}<div class="actions">${reactions(post)}${actions('post',post,userId)}</div></article>
    <section><h2>Comments</h2><ol class="comments">${list||'<li class="muted">No comments yet.</li>'}</ol>
    <form id="create-comment" data-post-id="${e(post.id)}"><label>Reply<textarea name="body" required maxlength="5000"></textarea></label><button>Comment</button></form></section>`;
}
export function renderCommunityAdmin({hub,spaces,reports}) {
  const spaceRows=spaces.map(s=>`<tr><td>${e(s.title)}</td><td>${e(visibilities[s.visibility]??s.visibility)}${s.company_org?` <code>${e(s.company_org)}</code>`:''}</td><td>${badge(s.status)}</td><td class="num">${e(s.posts)}</td>
    <td><button type="button" class="space-status" data-space-id="${e(s.id)}" data-status="${s.status==='active'?'archived':'active'}">${s.status==='active'?'Archive':'Reopen'}</button></td></tr>`).join('');
  const reportRows=reports.map(r=>`<li><p class="meta"><strong>${e(r.target_type==='post'?'Post':'Comment')} in ${e(r.space_title)}</strong>${badge(r.target_status==='visible'?'pending':r.target_status,'now '+r.target_status)}<span>reported ${when(r.created_at)}</span></p>
    <blockquote>${renderBody(r.target_body)}</blockquote><p>Reason: ${e(r.reason)}</p>
    <div class="actions">${['dismiss','hide','remove','suspend'].map(a=>`<button type="button" class="resolve-report" data-report-id="${e(r.id)}" data-action="${a}">${({dismiss:'Dismiss',hide:'Hide',remove:'Remove',suspend:'Remove and suspend author'})[a]}</button>`).join('')}</div></li>`).join('');
  return `<h1>Community moderation</h1>
    <section><h2>Open reports${reports.length?` <span class="badge warn">${reports.length} waiting</span>`:''}</h2><p class="muted">Resolving a report closes every open report on the same post or comment. Suspension applies only to ordinary members.</p><ol class="rows">${reportRows||'<li class="muted">No open reports.</li>'}</ol></section>
    <section><h2>Spaces</h2>${spaceRows?`<div class="table"><table><thead><tr><th>Space</th><th>Who can join</th><th>Status</th><th class="num">Posts</th><th></th></tr></thead><tbody>${spaceRows}</tbody></table></div>`:'<p class="muted">No spaces yet.</p>'}</section>
    <form id="create-space"><h2>Create a space</h2><label>Title<input name="title" required maxlength="120"></label>
    <label>Description<textarea name="description" maxlength="2000"></textarea></label>
    <label>Who can join<select name="visibility">${Object.entries(visibilities).map(([v,l])=>`<option value="${v}">${l}</option>`).join('')}</select></label>
    <label>Company organisation ID <small>(only for company spaces)</small><input name="companyOrg" pattern="[0-9a-fA-F-]{36}"></label><button>Create space</button></form>`;
}
