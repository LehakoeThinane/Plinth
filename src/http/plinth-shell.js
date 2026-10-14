// Static browser code. Credentials remain in HttpOnly cookies, never storage.
const {hubId,slug,csrf,orgId,productId,lessonId,revision}=document.body.dataset;
const status=document.querySelector('#status');
async function request(path,method,body,headers={}) {
  const response=await fetch('/v1/hubs/'+hubId+'/'+path,{method,credentials:'same-origin',
    headers:{'content-type':'application/json','x-csrf-token':csrf,...headers},body:body===undefined?undefined:JSON.stringify(body)});
  if(!response.ok)throw Object.assign(new Error(response.status===401?'Please sign in again.':response.status===403?'Please refresh the page or sign in again, then retry.':response.status===409?'The change conflicts with the current state. Refresh and review it.':'Your change could not be saved. Please try again.'),{status:response.status});
  return response.json();
}
async function saveConsents(form,onlyGrants=false) {
  for(const input of form.querySelectorAll('[data-purpose]')) {
    if(onlyGrants && !input.checked)continue;
    await request('consents','PUT',{purpose:input.dataset.purpose,granted:input.checked,noticeVersion:input.dataset.version});
  }
}
function formHandler(id,operation) {
  document.querySelector('#'+id)?.addEventListener('submit',async event=>{
    event.preventDefault();const button=event.currentTarget.querySelector('button');button.disabled=true;
    try{await operation(event.currentTarget);status.textContent='Changes saved.';}
    catch(error){status.textContent=error.message;}finally{button.disabled=false;}
  });
}
formHandler('branding',form=>request('branding','PUT',Object.fromEntries(new FormData(form))));
formHandler('domain-request',async form=>{
  const proof=await request('domains','POST',Object.fromEntries(new FormData(form)));
  document.querySelector('#domain-proof').textContent='Add a TXT record at '+proof.recordName+' with value '+proof.recordValue+'. Expires '+proof.expiresAt+'. Copy this value now; refreshing hides it.';
  const button=document.createElement('button');button.type='button';button.textContent='Check this DNS proof';
  button.addEventListener('click',async()=>{button.disabled=true;try{await request('domains/verify','POST',{hostname:proof.hostname});window.location.reload();}catch(error){status.textContent=error.message;button.disabled=false;}});
  document.querySelector('#domain-proof').append(' ',button);
});
for(const button of document.querySelectorAll('.verify-domain,.remove-domain'))button.addEventListener('click',async()=>{
  button.disabled=true;try{await request(button.classList.contains('verify-domain')?'domains/verify':'domains',button.classList.contains('verify-domain')?'POST':'DELETE',{hostname:button.dataset.hostname});window.location.reload();}catch(error){status.textContent=error.message;button.disabled=false;}
});
formHandler('org-domain-request',async form=>{
  const proof=await request('organisations/'+orgId+'/domains','POST',Object.fromEntries(new FormData(form)));
  document.querySelector('#org-domain-proof').textContent='Add a TXT record at '+proof.recordName+' with value '+proof.recordValue+'. Expires '+proof.expiresAt+'. Copy this value now; refreshing hides it.';
});
for(const button of document.querySelectorAll('.verify-org-domain,.remove-org-domain'))button.addEventListener('click',async()=>{
  const verify=button.classList.contains('verify-org-domain');
  if(!verify&&!window.confirm('Remove this organisation domain?'))return;
  button.disabled=true;
  try{await request('organisations/'+orgId+'/domains'+(verify?'/verify':''),verify?'POST':'DELETE',{domain:button.dataset.domain});window.location.reload();}
  catch(error){status.textContent=error.message;button.disabled=false;}
});
formHandler('logo',async form=>{
  const file=form.elements.image.files[0];
  if(!file || file.size>2*1024*1024)throw new Error('Choose an image up to 2 MB.');
  const response=await fetch('/v1/hubs/'+hubId+'/branding/logo',{method:'PUT',credentials:'same-origin',headers:{'content-type':file.type,'x-csrf-token':csrf},body:file});
  if(!response.ok)throw new Error('The logo could not be saved. Choose a static PNG, JPEG or WebP up to 2 MB.');
  window.location.reload();
});
document.querySelector('#remove-logo')?.addEventListener('click',async()=>{
  try{await request('branding/logo','DELETE');window.location.reload();}catch(error){status.textContent=error.message;}
});
formHandler('create-hub',async form=>{
  const response=await fetch('/v1/hubs',{method:'POST',credentials:'same-origin',
    headers:{'content-type':'application/json','x-csrf-token':csrf},body:JSON.stringify(Object.fromEntries(new FormData(form)))});
  if(!response.ok)throw new Error(response.status===409?'That hub address is already taken.':'The hub could not be created. Please try again.');
  const hub=await response.json();window.location.assign('/h/'+encodeURIComponent(hub.slug));
});
formHandler('consents',form=>saveConsents(form));
for(const form of document.querySelectorAll('.publish-notice'))form.addEventListener('submit',async event=>{
  event.preventDefault();const button=form.querySelector('button');button.disabled=true;
  try{await request('notices','PUT',{...Object.fromEntries(new FormData(form)),expectedVersion:form.dataset.expectedVersion||null});window.location.reload();}
  catch(error){status.textContent=error.message;}finally{button.disabled=false;}
});
for(const button of document.querySelectorAll('.retire-notice'))button.addEventListener('click',async()=>{
  if(!window.confirm('Retire this purpose? Existing agreements stop counting and members can no longer agree to it.'))return;
  button.disabled=true;
  try{await request('notices/retire','POST',{purpose:button.dataset.purpose,expectedVersion:button.dataset.version});window.location.reload();}
  catch(error){status.textContent=error.message;button.disabled=false;}
});
const product=path=>'catalogue/products/'+productId+path;
formHandler('create-product',async form=>{
  const data=Object.fromEntries(new FormData(form));
  if(data.visibility!=='company')delete data.companyOrg;
  try{const created=await request('catalogue/products','POST',data);window.location.assign('/h/'+slug+'/admin/products/'+created.id);}
  catch(error){throw error.status===400?new Error('Check the details. Company products need a valid organisation ID and paid access.'):error;}
});
formHandler('product-details',async form=>{
  const data=Object.fromEntries(new FormData(form));
  if(form.elements.accessMode.disabled)delete data.accessMode;
  await request(product(''),'PATCH',data);
});
formHandler('add-module',async form=>{await request(product('/modules'),'POST',Object.fromEntries(new FormData(form)));window.location.reload();});
for(const form of document.querySelectorAll('.add-lesson'))form.addEventListener('submit',async event=>{
  event.preventDefault();const button=form.querySelector('button');button.disabled=true;
  try{await request(product('/lessons'),'POST',{moduleId:form.dataset.moduleId,title:form.elements.title.value,summary:form.elements.summary.value,previewAvailable:form.elements.previewAvailable.checked});window.location.reload();}
  catch(error){status.textContent=error.message;button.disabled=false;}
});
for(const form of document.querySelectorAll('.lesson-content'))form.addEventListener('submit',async event=>{
  event.preventDefault();const button=form.querySelector('button');button.disabled=true;
  try{await request(product('/lessons/'+form.dataset.lessonId+'/content'),'PUT',{body:form.elements.body.value});status.textContent='Lesson content saved.';}
  catch(error){status.textContent=error.message;}finally{button.disabled=false;}
});
formHandler('add-plan',async form=>{
  const amount=form.elements.amount.value.replace(',','.'),model=form.elements.model.value;
  if(!/^[0-9]+(\.[0-9]{1,2})?$/.test(amount))throw new Error('Enter the amount in rand, for example 1250.00.');
  const [whole,fraction='']=amount.split('.'),amountCents=Number(whole)*100+Number(fraction.padEnd(2,'0'));
  await request(product('/plans'),'POST',{model,amountCents,interval:model==='subscription'?form.elements.interval.value:null});window.location.reload();
});
for(const button of document.querySelectorAll('.retire-plan'))button.addEventListener('click',async()=>{
  if(!window.confirm('Retire this price? It can no longer be bought.'))return;
  button.disabled=true;
  try{await request(product('/plans/'+button.dataset.planId),'DELETE');window.location.reload();}
  catch(error){status.textContent=error.status===409?'A live paid product needs at least one active price. Add another price first.':error.message;button.disabled=false;}
});
document.querySelector('#publish-product')?.addEventListener('click',async event=>{
  const button=event.currentTarget;
  if(!window.confirm('Publish now? Published products cannot be withdrawn yet.'))return;
  button.disabled=true;
  try{await request(product('/publish'),'POST');window.location.reload();}
  catch(error){status.textContent=error.status===409?'Add at least one lesson, and an active price for paid products, before publishing.':error.message;button.disabled=false;}
});
document.querySelector('#complete-lesson')?.addEventListener('click',async event=>{
  const button=event.currentTarget;button.disabled=true;
  // One key per attempt: a retried send of the same click is answered from the stored result.
  const key=crypto.randomUUID();
  const update={baseRevision:Number(revision),furthestPosition:1,resumePosition:1,completed:true};
  for(let attempt=0;attempt<3;attempt++) {
    try{await request('lessons/'+lessonId+'/progress','PUT',update,{'idempotency-key':key});window.location.reload();return;}
    catch(error){if(error.status&&error.status<500){status.textContent=error.message;break;}status.textContent='Connection problem; retrying…';}
  }
  button.disabled=false;
});
function libraryItem(form) {
  const data=Object.fromEntries(new FormData(form));
  data.topics=data.topics.split(',').map(t=>t.trim().toLowerCase()).filter(Boolean);
  if(data.visibility==='entitled'){if(!data.requiredProductId)throw new Error('Choose the product whose buyers can read this item.');}
  else delete data.requiredProductId;
  return data;
}
const libraryError=error=>error.status===400?new Error('Check the item. Topics are lowercase words joined by hyphens, at most five.'):error;
formHandler('create-library-item',async form=>{
  try{const created=await request('catalogue/library','POST',libraryItem(form));window.location.assign('/h/'+slug+'/admin/library/'+created.id);}
  catch(error){throw libraryError(error);}
});
formHandler('library-item',async form=>{
  try{await request('catalogue/library/'+form.dataset.itemId,'PATCH',libraryItem(form));}catch(error){throw libraryError(error);}
});
for(const button of document.querySelectorAll('.library-status'))button.addEventListener('click',async()=>{
  const id=document.querySelector('#library-item').dataset.itemId,action=button.dataset.action;
  if(action==='archive'&&!window.confirm('Archive this item? It will disappear from the library and cannot return to draft.'))return;
  button.disabled=true;
  try{await request('catalogue/library/'+id+'/'+action,'POST');window.location.reload();}
  catch(error){status.textContent=error.message;button.disabled=false;}
});
formHandler('create-post',async form=>{await request('spaces/'+form.dataset.spaceId+'/posts','POST',{body:form.elements.body.value});window.location.reload();});
formHandler('create-comment',async form=>{await request('posts/'+form.dataset.postId+'/comments','POST',{body:form.elements.body.value});window.location.reload();});
const clickAll=(selector,handler)=>{for(const button of document.querySelectorAll(selector))button.addEventListener('click',async()=>{
  button.disabled=true;try{if(await handler(button)!==false)window.location.reload();else button.disabled=false;}catch(error){status.textContent=error.message;button.disabled=false;}
});};
clickAll('.react',b=>request('posts/'+b.dataset.postId+'/reactions/'+b.dataset.kind,b.dataset.on==='true'?'PUT':'DELETE'));
clickAll('.withdraw',async b=>{
  if(!window.confirm('Delete this '+b.dataset.type+'? It cannot be restored.'))return false;
  await request((b.dataset.type==='post'?'posts/':'comments/')+b.dataset.id,'DELETE');
});
clickAll('.report',async b=>{
  const reason=window.prompt('Why are you reporting this '+b.dataset.type+'? Moderators will review it.');
  if(!reason||!reason.trim())return false;
  await request('reports','POST',{targetType:b.dataset.type,targetId:b.dataset.id,reason:reason.slice(0,1000)});
  status.textContent='Thank you. The moderators have been notified.';return false;
});
formHandler('create-space',async form=>{
  const data=Object.fromEntries(new FormData(form));if(data.visibility!=='company')delete data.companyOrg;
  await request('catalogue/spaces','POST',data);window.location.reload();
});
clickAll('.space-status',b=>request('catalogue/spaces/'+b.dataset.spaceId,'PATCH',{status:b.dataset.status}));
clickAll('.resolve-report',async b=>{
  if(b.dataset.action==='suspend'&&!window.confirm('Remove this content and suspend its author from the hub?'))return false;
  await request('catalogue/reports/'+b.dataset.reportId+'/resolve','POST',{action:b.dataset.action});
});
function tierFields(form) {
  const data={name:form.elements.name.value,description:form.elements.description.value,rank:Number(form.elements.rank.value)};
  if(!form.elements.amount.disabled) {
    const amount=form.elements.amount.value.replace(',','.');
    if(!/^[0-9]+(\.[0-9]{1,2})?$/.test(amount))throw new Error('Enter the price in rand, for example 200.00.');
    const [whole,fraction='']=amount.split('.');data.amountCents=Number(whole)*100+Number(fraction.padEnd(2,'0'));data.interval=form.elements.interval.value;
  }
  return data;
}
const tierError=error=>error.status===409?new Error('Another tier already uses that rank, or the change is not allowed for a published tier.'):error;
formHandler('create-tier',async form=>{
  try{const created=await request('catalogue/tiers','POST',tierFields(form));window.location.assign('/h/'+slug+'/admin/tiers/'+created.id);}catch(error){throw tierError(error);}
});
formHandler('tier-details',async form=>{try{await request('catalogue/tiers/'+form.dataset.tierId,'PATCH',tierFields(form));}catch(error){throw tierError(error);}});
formHandler('add-benefit',async form=>{
  const [targetType,targetId]=form.elements.benefit.value.split(':');
  await request('catalogue/tiers/'+form.dataset.tierId+'/benefits','POST',{targetType,targetId});window.location.reload();
});
clickAll('.remove-benefit',b=>request('catalogue/tiers/'+document.querySelector('#tier-details').dataset.tierId+'/benefits/'+b.dataset.targetId,'DELETE'));
clickAll('.tier-status',async b=>{
  if(b.dataset.action==='archive'&&!window.confirm('Archive this tier? It stops being offered and cannot be reopened.'))return false;
  await request('catalogue/tiers/'+document.querySelector('#tier-details').dataset.tierId+'/'+b.dataset.action,'POST');
});
document.querySelector('#start-checkout')?.addEventListener('click',async event=>{
  const button=event.currentTarget;button.disabled=true;
  // One key per page: a double click or retry returns the same order.
  const key=button.dataset.key||(button.dataset.key=crypto.randomUUID());
  const response=await fetch('/v1/hubs/'+hubId+'/checkout',{method:'POST',credentials:'same-origin',
    headers:{'content-type':'application/json','x-csrf-token':csrf,'idempotency-key':key},body:JSON.stringify({planId:button.dataset.planId,slug})});
  const result=await response.json().catch(()=>({}));
  if(response.ok&&result.redirectUrl){window.location.assign(result.redirectUrl);return;}
  if(response.ok){window.location.assign('/h/'+slug+'/orders/'+result.orderId);return;}
  const messages={join_first:'Join this hub before buying.',already_owned:'You already have this product. Find it in My learning.',not_yet_supported:'This price type is not on sale yet.'};
  status.textContent=messages[result.error]??'Checkout could not start. Please try again.';button.disabled=false;
});
clickAll('.refund-order',async b=>{
  if(!window.confirm('Refund this order in full? The buyer loses access when the provider confirms.'))return false;
  await request('catalogue/sales/'+b.dataset.orderId+'/refund','POST');
});
formHandler('create-enquiry',async form=>{
  const data=Object.fromEntries(new FormData(form));if(!data.requesterOrg)delete data.requesterOrg;
  const created=await request('enquiries','POST',data);window.location.assign('/h/'+slug+'/enquiries/'+created.id);
});
formHandler('send-message',async form=>{
  // The client id makes a retried send post once.
  const clientId=form.dataset.clientId||(form.dataset.clientId=crypto.randomUUID());
  await request('conversations/'+form.dataset.conversationId+'/messages','POST',{body:form.elements.body.value,clientId});
  delete form.dataset.clientId;window.location.reload();
});
formHandler('enquiry-status',async form=>{await request('enquiries/'+form.dataset.enquiryId,'PATCH',{status:form.elements.status.value});window.location.reload();});
// Opening a thread marks it read.
{const thread=document.querySelector('ol.messages[data-conversation-id]');if(thread)request('conversations/'+thread.dataset.conversationId+'/read','PUT').catch(()=>{});}
formHandler('create-organisation',async form=>{const org=await request('organisations','POST',Object.fromEntries(new FormData(form)));window.location.assign('/h/'+slug+'/organisations?org='+org.id);});
formHandler('rename-organisation',form=>request('organisations/'+orgId,'PUT',Object.fromEntries(new FormData(form))));
formHandler('accept-invitation',async form=>{const data=Object.fromEntries(new FormData(form));await request('organisations/'+encodeURIComponent(data.orgId)+'/accept','POST',{token:data.token});form.reset();window.location.assign('/h/'+slug+'/organisations');});
formHandler('invite-member',async form=>{
  const invitation=await request('organisations/'+orgId+'/invitations','POST',Object.fromEntries(new FormData(form)));
  document.querySelector('#invitation-result').textContent='Share privately with the intended account: organisation '+orgId+', code '+invitation.token+'. This code is shown once.';
});
for(const form of document.querySelectorAll('.member-role'))form.addEventListener('submit',async event=>{
  event.preventDefault();const button=form.querySelector('button');button.disabled=true;
  try{await request('organisations/'+orgId+'/members/'+form.dataset.userId,'PUT',{role:new FormData(form).get('role')});window.location.reload();}
  catch(error){status.textContent=error.message;}finally{button.disabled=false;}
});
for(const button of document.querySelectorAll('.remove-member,.revoke-invitation'))button.addEventListener('click',async()=>{
  if(button.classList.contains('remove-member')&&!window.confirm('Remove this person’s organisation membership?'))return;
  button.disabled=true;
  try{await request('organisations/'+orgId+'/'+(button.dataset.userId?'members/'+button.dataset.userId:'invitations/'+button.dataset.id),'DELETE');window.location.reload();}
  catch(error){status.textContent=error.message;}finally{button.disabled=false;}
});
document.querySelector('#link-method')?.addEventListener('click',async event=>{
  const button=event.currentTarget;button.disabled=true;
  try{const started=await request('account/links','POST',{slug});window.location.assign(started.location);}
  catch(error){status.textContent=error.message;button.disabled=false;}
});
for(const button of document.querySelectorAll('.unlink-method'))button.addEventListener('click',async()=>{
  if(!window.confirm('Remove this sign-in method? You will be signed out on your other devices.'))return;
  button.disabled=true;
  try{await request('account/links','DELETE',{issuer:button.dataset.issuer,subject:button.dataset.subject});window.location.reload();}
  catch(error){status.textContent=error.message;button.disabled=false;}
});
formHandler('join',async form=>{await request('join','POST');await saveConsents(form,true);window.location.assign('/h/'+slug+'/member');});
document.querySelector('#logout')?.addEventListener('click',async()=>{
  try{await request('session','DELETE');window.location.assign('/h/'+slug);}catch(error){status.textContent=error.message;}
});
