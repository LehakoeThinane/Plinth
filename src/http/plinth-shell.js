// Static browser code. Credentials remain in HttpOnly cookies, never storage.
const {hubId,slug,csrf,orgId}=document.body.dataset;
const status=document.querySelector('#status');
async function request(path,method,body) {
  const response=await fetch('/v1/hubs/'+hubId+'/'+path,{method,credentials:'same-origin',
    headers:{'content-type':'application/json','x-csrf-token':csrf},body:body===undefined?undefined:JSON.stringify(body)});
  if(!response.ok)throw new Error(response.status===401?'Please sign in again.':response.status===409?'The change conflicts with the current state. Refresh and review it.':'Your change could not be saved. Please try again.');
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
formHandler('join',async form=>{await request('join','POST');await saveConsents(form,true);window.location.assign('/h/'+slug+'/member');});
document.querySelector('#logout')?.addEventListener('click',async()=>{
  try{await request('session','DELETE');window.location.assign('/h/'+slug);}catch(error){status.textContent=error.message;}
});
