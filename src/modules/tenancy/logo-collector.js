// Uploads store the object moments before publishing its pointer; never collect
// anything younger than this, so an in-flight upload cannot lose its file.
export const logoGracePeriodMs=60*60*1000;
/** Removes stored logo objects that are not their hub's current published logo.
 * Dry run by default: it reports candidates and deletes only with apply=true.
 */
export async function collectLogos({store,isPublishedLogo,now=Date.now(),graceMs=logoGracePeriodMs,apply=false}) {
  if(!Number.isFinite(graceMs)||graceMs<60*1000)throw Error('Grace period must be at least one minute');
  const result={dryRun:!apply,kept:0,recent:0,removed:[]};
  for(const hubId of await store.hubs())for(const object of await store.list(hubId)) {
    if(now-object.modifiedAt.getTime()<graceMs){result.recent++;continue;}
    if(await isPublishedLogo(hubId,object.id+'.webp')){result.kept++;continue;}
    if(apply)await store.delete(hubId,object.id);
    result.removed.push({hubId,id:object.id});
  }
  return result;
}
