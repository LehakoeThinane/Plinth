import { escapeText as e } from './storefront.js';
import { when } from './ui.js';
const outcomes={
  linked:'The sign-in method is now linked to this account.',
  unchanged:'That sign-in method was already linked to this account.',
  conflict:'That sign-in method belongs to a different account, so it was not linked. Nothing was changed.'
};
const provider=issuer=>{try{return new URL(issuer).host||issuer;}catch{return issuer;}};
export function renderAccount({hub,account,signIn}) {
  const single=signIn.methods.length<=1;
  const methods=signIn.methods.map(m=>`<li><p class="meta"><strong>${e(provider(m.issuer))}</strong><code>${e(m.subject)}</code><span>linked ${when(m.created_at)}</span>
    ${single?'':`<button type="button" class="unlink-method" data-issuer="${e(m.issuer)}" data-subject="${e(m.subject)}"${signIn.recent?'':' disabled'}>Remove</button>`}</p></li>`).join('');
  const reauthenticate=`<p class="muted">For your protection, changing sign-in methods needs a sign-in from the last 10 minutes.
    <a href="/h/${e(hub.slug)}/sign-in?view=account">Sign in again</a> to continue.</p>`;
  const linking=signIn.linkingEnabled?`<p class="muted">Linking asks you to sign in with the other method. It cannot move a method that already belongs to another account.</p>
    <p class="actions"><button type="button" id="link-method"${signIn.recent?'':' disabled'}>Link another sign-in method</button></p>`:'';
  return `<h1>Sign-in methods</h1><p class="muted">Your account ID: <code>${e(account.user.id)}</code></p>
    ${outcomes[signIn.outcome]?`<p role="status" class="panel">${e(outcomes[signIn.outcome])}</p>`:''}
    <section><h2>Linked methods</h2><p class="muted">Any of these signs you in to this same account.${single?' You cannot remove your only sign-in method.':' Removing one signs you out on your other devices.'}</p>
    <ul class="rows">${methods}</ul>${signIn.recent?'':reauthenticate}${linking}</section>
    <section><h2>Recent changes</h2><ul class="rows">${signIn.events.map(ev=>`<li><p class="meta">${when(ev.created_at)}<strong>${e(ev.action)}</strong><span>${e(provider(ev.issuer))}</span><code>${e(ev.subject)}</code></p></li>`).join('')||'<li class="muted">No changes yet.</li>'}</ul></section>`;
}
