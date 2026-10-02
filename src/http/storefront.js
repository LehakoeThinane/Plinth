export function escapeText(value) {
  return String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[char]);
}
export function renderStorefront(hub) {
  const color=/^#[0-9a-f]{6}$/i.test(hub.primary_color)?hub.primary_color:'#2456A6';
  const font=({system:'system-ui, sans-serif',serif:'Georgia, serif',sans:'Arial, sans-serif'})[hub.font]??'system-ui, sans-serif';
  const logo=typeof hub.logo_path==='string' &&
    new RegExp('^/assets/hubs/'+hub.id+'/branding/[a-zA-Z0-9_-]+\\.(png|jpg|webp)$').test(hub.logo_path)?
    '<img class="logo" src="'+escapeText(hub.logo_path)+'" alt="">':'';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeText(hub.display_name)}</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#f6f7fa;color:#172334;font-family:${font};line-height:1.6}
header{background:white;border-top:6px solid ${color};border-bottom:1px solid #dce2ea}
.wrap{max-width:1000px;margin:auto;padding:24px}header .wrap{display:flex;align-items:center;gap:16px}
.logo{max-width:64px;max-height:64px}h1{font-size:clamp(2rem,5vw,3.25rem);line-height:1.15;margin:20px 0}
.eyebrow{font-size:.85rem;letter-spacing:.08em;text-transform:uppercase;color:#44556b}
.intro{max-width:680px;padding-top:48px;padding-bottom:40px}.description{white-space:pre-wrap;font-size:1.1rem}
.card{background:white;padding:28px;border:1px solid #dce2ea;border-radius:12px;margin-bottom:40px}
h2{margin-top:0}footer{color:#44556b;font-size:.9rem}
</style></head><body>
<header><div class="wrap">${logo}<strong>${escapeText(hub.display_name)}</strong></div></header>
<main class="wrap"><section class="intro"><p class="eyebrow">Learning &amp; knowledge exchange</p>
<h1>${escapeText(hub.display_name)}</h1>
<p class="description">${escapeText(hub.description||'A place to learn, connect, and exchange ideas.')}</p></section>
<section class="card" aria-labelledby="courses"><h2 id="courses">Explore courses</h2><p>New courses will appear here as they are published.</p></section>
</main><footer class="wrap">Powered by Plinth</footer></body></html>`;
}
