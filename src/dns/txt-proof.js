import { createHash } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
/** DNS TXT ownership proofs shared by hub and organisation domains. */
export const proofRecordPrefix='_plinth-verification.';
export const domainDigest=value=>createHash('sha256').update(value).digest('hex');
export function domainHostname(value) {
  if(typeof value!=='string')throw Object.assign(new Error('Invalid hostname'),{status:400});
  const host=value.toLowerCase();
  if(host.length>232||!/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)
    || /\.(local|localhost|internal|test|invalid|example)$/.test(host))throw Object.assign(new Error('Invalid hostname'),{status:400});
  return host;
}
// Dedicated resolver per lookup: deadline cancellation cannot cancel other requests.
export async function resolveDomainTxt(name) {
  const resolver=new Resolver({timeout:2000,tries:1});
  const timer=setTimeout(()=>resolver.cancel(),3000);
  try{return await resolver.resolveTxt(name);}finally{clearTimeout(timer);}
}
/** Resolves the proof record and requires one TXT record (chunks joined) whose
 * value has the given prefix and hashes to the stored challenge.
 */
export async function hasTxtProof(resolveTxt,hostname,prefix,challengeHash) {
  let records;
  try{records=await resolveTxt(proofRecordPrefix+hostname);}
  catch(error){if(['ENODATA','ENOTFOUND'].includes(error.code))records=[];else throw Object.assign(new Error('DNS unavailable'),{status:409});}
  const pattern=new RegExp('^'+prefix+'=[0-9a-f]{64}$');
  return Array.isArray(records)&&records.some(parts=>Array.isArray(parts)&&parts.every(p=>typeof p==='string')&&
    parts.join('').length<=128 && pattern.test(parts.join(''))&&domainDigest(parts.join(''))===challengeHash);
}
