import { escapeText as e,renderBody } from './storefront.js';
const statuses={open:'Open',in_discussion:'In discussion',closed:'Closed'};
export function renderEnquiries({hub,inbox}) {
  const rows=inbox.enquiries.map(q=>`<tr><td><a href="/h/${e(hub.slug)}/enquiries/${e(q.id)}">${e(q.subject)}</a></td><td>${e(statuses[q.status]??q.status)}</td>
    <td>${e(q.last_message_at??q.created_at)}</td><td>${q.unread?`<strong>${e(q.unread)} new</strong>`:''}</td></tr>`).join('');
  const form=inbox.provider?'':`<form id="create-enquiry"><h2>Ask about bespoke work</h2>
    <p>Describe what you need. The provider replies here; any agreement and contract happen directly between you, off the platform.</p>
    <label>Subject<input name="subject" required maxlength="200"></label>
    <label>What do you need?<textarea name="need" required maxlength="5000" rows="8"></textarea></label>
    <label>Company organisation ID <small>(optional, if you are asking for your company)</small><input name="requesterOrg" pattern="[0-9a-fA-F-]{36}"></label>
    <button>Send enquiry</button></form>`;
  return `<h1>${inbox.provider?'Enquiries inbox':'Your enquiries'}</h1>
    ${rows?`<table><thead><tr><th>Subject</th><th>Status</th><th>Last activity</th><th></th></tr></thead><tbody>${rows}</tbody></table>`:`<p>${inbox.provider?'No enquiries yet.':'You have not sent any enquiries yet.'}</p>`}${form}`;
}
export function renderEnquiry({hub,thread,userId}) {
  const {enquiry,messages,older,provider}=thread,closed=enquiry.status==='closed';
  const who=m=>m.sender_id===userId?'You':m.sender_role==='provider'?'Provider':'Enquirer';
  const list=messages.map(m=>`<li><p><strong>${e(who(m))}</strong> · ${e(m.created_at)}</p>${renderBody(m.body)}</li>`).join('');
  const status=provider?`<form id="enquiry-status" data-enquiry-id="${e(enquiry.id)}"><label>Status<select name="status">${Object.entries(statuses).map(([v,l])=>`<option value="${v}"${v===enquiry.status?' selected':''}>${l}</option>`).join('')}</select></label><button>Update status</button></form>`:'';
  return `<p><a href="/h/${e(hub.slug)}/enquiries">All enquiries</a></p><h1>${e(enquiry.subject)}</h1><p>Status: ${e(statuses[enquiry.status]??enquiry.status)}</p>${status}
    ${older?'<p>Earlier messages are available through the API.</p>':''}<ol class="messages" data-conversation-id="${e(enquiry.conversation_id)}">${list}</ol>
    ${closed?'<p>This enquiry is closed.</p>':`<form id="send-message" data-conversation-id="${e(enquiry.conversation_id)}"><label>Reply<textarea name="body" required maxlength="5000"></textarea></label><button>Send</button></form>`}`;
}
