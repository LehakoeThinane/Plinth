export function validateBranding(input,hubId) {
  const fields={displayName:'display_name',description:'description',primaryColor:'primary_color',font:'font',logoPath:'logo_path'};
  if(!input || typeof input!=='object' || Array.isArray(input) || !Object.keys(input).length ||
    Object.keys(input).some(key=>!Object.hasOwn(fields,key)))throw Object.assign(new Error('Invalid branding'),{status:400});
  for(const [key,value] of Object.entries(input)) {
    const valid=key==='displayName'?typeof value==='string' && value.trim().length>0 && value.length<=200:
      key==='description'?typeof value==='string' && value.length<=2000:
      key==='primaryColor'?typeof value==='string' && /^#[0-9a-f]{6}$/i.test(value):
      key==='font'?['system','serif','sans'].includes(value):
      value===null || (typeof value==='string' && new RegExp('^/assets/hubs/'+hubId+'/branding/[a-zA-Z0-9_-]+\\.(png|jpg|webp)$').test(value));
    if(!valid)throw Object.assign(new Error('Invalid branding'),{status:400});
  }
  return Object.entries(input).map(([key,value])=>[fields[key],value]);
}
