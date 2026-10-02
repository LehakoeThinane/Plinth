// Static browser code. Credentials remain in HttpOnly cookies, never storage.
const {hubId,slug,csrf}=document.body.dataset;
const status=document.querySelector('#status');
async function request(path,method,body) {
  const response=await fetch('/v1/hubs/'+hubId+'/'+path,{method,credentials:'same-origin',
    headers:{'content-type':'application/json','x-csrf-token':csrf},body:body===undefined?undefined:JSON.stringify(body)});
  if(!response.ok)throw new Error(response.status===401?'Please sign in again.':response.status===409?'A consent notice changed. Refresh the page and review it.':'Your change could not be saved. Please try again.');
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
formHandler('create-hub',async form=>{
  const response=await fetch('/v1/hubs',{method:'POST',credentials:'same-origin',
    headers:{'content-type':'application/json','x-csrf-token':csrf},body:JSON.stringify(Object.fromEntries(new FormData(form)))});
  if(!response.ok)throw new Error(response.status===409?'That hub address is already taken.':'The hub could not be created. Please try again.');
  const hub=await response.json();window.location.assign('/h/'+encodeURIComponent(hub.slug));
});
formHandler('consents',form=>saveConsents(form));
formHandler('join',async form=>{await request('join','POST');await saveConsents(form,true);window.location.assign('/h/'+slug+'/member');});
document.querySelector('#logout')?.addEventListener('click',async()=>{
  try{await request('session','DELETE');window.location.assign('/h/'+slug);}catch(error){status.textContent=error.message;}
});
