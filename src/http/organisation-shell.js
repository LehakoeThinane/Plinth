import { escapeText as e } from './storefront.js';
export function renderOrganisations({hub,account,organisation}) {
  const org=organisation?.organisation;
  const listing=account.organisations.map(o=>`<li>${e(o.display_name||'Organisation')} (${e(o.role)}) ${o.role==='admin'?`<a href="/h/${e(hub.slug)}/organisations?org=${e(o.id)}">Manage</a>`:''}</li>`).join('');
  const creation=`<form id="create-organisation"><h2>Create an organisation</h2><label>Display name<input name="displayName" required maxlength="200"></label>
    <label>Legal name<input name="legalName" required maxlength="200"></label><label>Type<select name="type"><option value="company">Company</option><option value="provider">Provider</option></select></label><button>Create organisation</button></form>`;
  const acceptance=`<form id="accept-invitation"><h2>Accept an invitation</h2><p>Ask your administrator for the organisation ID and invitation code.</p>
    <label>Organisation ID<input name="orgId" required></label><label>Invitation code<input name="token" type="password" autocomplete="off" required minlength="64" maxlength="64"></label><button>Accept invitation</button></form>`;
  const admin=org?`<section><h2>Manage ${e(org.displayName)}</h2><p>Organisation ID: <code>${e(org.id)}</code></p>
    <form id="rename-organisation"><label>Display name<input name="displayName" value="${e(org.displayName)}" required maxlength="200"></label>
      <label>Legal name<input name="legalName" value="${e(org.legalName)}" required maxlength="200"></label><button>Save names</button></form>
    <form id="invite-member"><h3>Invite an existing account</h3><p>The person must share their account ID and accept the invitation. Invitations expire after seven days.</p>
      <label>Account ID<input name="userId" required></label><button>Create invitation</button><p id="invitation-result" role="status"></p></form>
    <h3>Members</h3><p>Keep at least one active administrator. Removing membership ends access to company content.</p>${organisation.members.map(m=>`<div><code>${e(m.userId)}</code> · ${e(m.status)} · ${e(m.role)}${m.status==='active'?`
      <form class="member-role" data-user-id="${e(m.userId)}"><label>Role<select name="role"><option value="member"${m.role==='member'?' selected':''}>Member</option><option value="admin"${m.role==='admin'?' selected':''}>Administrator</option></select></label><button>Save role</button></form>
      <button type="button" class="remove-member" data-user-id="${e(m.userId)}">Remove membership</button>`:''}</div>`).join('')}
    <h3>Invitations</h3>${organisation.invitations.map(i=>`<p><code>${e(i.userId)}</code> · ${i.accepted?'Accepted':i.revoked?'Revoked':'Expires '+e(i.expiresAt)}
      ${!i.accepted&&!i.revoked?`<button type="button" class="revoke-invitation" data-id="${e(i.id)}">Revoke</button>`:''}</p>`).join('')||'<p>No invitations.</p>'}
    <h3>Recent activity</h3><ul>${organisation.events.map(ev=>`<li>${e(ev.createdAt)} · ${e(ev.action)} · ${e(ev.targetUser||ev.actorUser)}</li>`).join('')}</ul></section>`:'';
  return `<h1>Your organisations</h1><p>Your account ID: <code>${e(account.user.id)}</code></p><ul>${listing||'<li>No active organisations.</li>'}</ul>${creation}${acceptance}${admin}`;
}
