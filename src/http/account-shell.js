import { escapeText as e } from './storefront.js';
const outcomes={
  linked:'The sign-in method is now linked to this account.',
  unchanged:'That sign-in method was already linked to this account.',
  conflict:'That sign-in method belongs to a different account, so it was not linked. Nothing was changed.'
};
const provider=issuer=>{try{return new URL(issuer).host||issuer;}catch{return issuer;}};
export function renderAccount({hub,account,signIn}) {
  const single=signIn.methods.length<=1;
  const methods=signIn.methods.map(m=>`<li>${e(provider(m.issuer))} · <code>${e(m.subject)}</code> · linked ${e(m.created_at)}
    ${single?'':`<button type="button" class="unlink-method" data-issuer="${e(m.issuer)}" data-subject="${e(m.subject)}"${signIn.recent?'':' disabled'}>Remove</button>`}</li>`).join('');
  const reauthenticate=`<p>For your protection, changing sign-in methods needs a sign-in from the last 10 minutes.
    <a href="/h/${e(hub.slug)}/sign-in?view=account">Sign in again</a> to continue.</p>`;
  const linking=signIn.linkingEnabled?`<p>Linking asks you to sign in with the other method. It cannot move a method that already belongs to another account.</p>
    <button type="button" id="link-method"${signIn.recent?'':' disabled'}>Link another sign-in method</button>`:'';
  return `<h1>Your account</h1><p>Your account ID: <code>${e(account.user.id)}</code></p>
    ${outcomes[signIn.outcome]?`<p role="status">${e(outcomes[signIn.outcome])}</p>`:''}
    <section><h2>Sign-in methods</h2><p>Any of these signs you in to this same account.${single?' You cannot remove your only sign-in method.':' Removing one signs you out on your other devices.'}</p>
    <ul>${methods}</ul>${signIn.recent?'':reauthenticate}${linking}</section>
    <section><h2>Recent sign-in method changes</h2><ul>${signIn.events.map(ev=>`<li>${e(ev.created_at)} · ${e(ev.action)} · ${e(provider(ev.issuer))} · <code>${e(ev.subject)}</code></li>`).join('')||'<li>No changes yet.</li>'}</ul></section>`;
}
