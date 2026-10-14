// Shared presentation helpers for every server-rendered page.
export function escapeText(value) {
  return String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[char]);
}
const e=escapeText;
const defaultBrand='#2D5B8A';
const displayFaces={serif:'"Newsreader", Georgia, "Times New Roman", serif',sans:'"Archivo", "Arial Narrow", Arial, sans-serif',system:'system-ui, -apple-system, "Segoe UI", sans-serif'};
/** White or ink text, whichever reads better on the hub colour (WCAG relative luminance). */
function onColor(hex) {
  const [r,g,b]=[1,3,5].map(i=>{const c=parseInt(hex.slice(i,i+2),16)/255;return c<=0.03928?c/12.92:((c+0.055)/1.055)**2.4;});
  const luminance=0.2126*r+0.7152*g+0.0722*b;
  return (1.05)/(luminance+0.05)>=(luminance+0.05)/0.05?'#FFFFFF':'#15191D';
}
/** Per-hub theme tokens. Only validated values reach the style element. */
export function hubTheme(hub) {
  const brand=/^#[0-9a-f]{6}$/i.test(hub?.primary_color??'')?hub.primary_color:defaultBrand;
  return `<style>:root{--brand:${brand};--on-brand:${onColor(brand)};--display:${displayFaces[hub?.font]??displayFaces.system}}</style>`;
}
/** Document head shared by every page: stylesheet, hub theme and optional browser script. */
export function head({title,hub=null,script=false}) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${e(title)}</title><link rel="stylesheet" href="/assets/plinth.css">${hubTheme(hub)}${script?'<script defer src="/assets/plinth-shell.js"></script>':''}</head>`;
}
const dateTime=new Intl.DateTimeFormat('en-ZA',{day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit',hour12:false,timeZone:'Africa/Johannesburg'});
const dateOnly=new Intl.DateTimeFormat('en-ZA',{day:'numeric',month:'short',year:'numeric',timeZone:'Africa/Johannesburg'});
/** South African local time, e.g. 14 Oct 2026, 10:42. Unparseable values pass through escaped. */
export function when(value,{time=true}={}) {
  if(value==null||value==='')return '';
  const date=value instanceof Date?value:new Date(value);
  if(Number.isNaN(date.getTime()))return e(value);
  return `<time datetime="${e(date.toISOString())}">${e((time?dateTime:dateOnly).format(date))}</time>`;
}
const tones={draft:'muted',published:'ok',archived:'muted',active:'ok',paid:'ok',pending:'warn',failed:'bad',review:'warn',refunded:'muted',
  open:'info',in_discussion:'warn',closed:'muted',retired:'muted',current:'ok',past_due:'bad',ended:'muted',hidden:'bad',removed:'bad',invited:'warn',revoked:'muted'};
/** A status shown as a labelled dot, so state reads at a glance and not by colour alone. */
export function badge(status,label=null) {
  return `<span class="badge ${tones[status]??'muted'}">${e(label??String(status??'').replaceAll('_',' '))}</span>`;
}
