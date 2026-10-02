import { createHash } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
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
export class DomainVerification {
  #repository;#resolve;
  constructor({repository,resolveTxt=resolveDomainTxt}){this.#repository=repository;this.#resolve=resolveTxt;}
  list(hubId){return this.#repository.list(hubId);}
  request(hubId,input){return this.#repository.request(hubId,domainHostname(input.hostname));}
  remove(hubId,input){return this.#repository.remove(hubId,domainHostname(input.hostname));}
  async verify(hubId,input) {
    const hostname=domainHostname(input.hostname),claim=await this.#repository.challenge(hubId,hostname);
    let records;
    try{records=await this.#resolve('_plinth-verification.'+hostname);}
    catch(error){if(['ENODATA','ENOTFOUND'].includes(error.code))records=[];else throw Object.assign(new Error('DNS unavailable'),{status:409});}
    const matched=Array.isArray(records)&&records.some(parts=>Array.isArray(parts)&&parts.every(p=>typeof p==='string')&&
      parts.join('').length<=128 && /^plinth-domain=[0-9a-f]{64}$/.test(parts.join(''))&&domainDigest(parts.join(''))===claim.challenge_hash);
    if(!matched)throw Object.assign(new Error('DNS proof missing'),{status:409});
    return this.#repository.confirm(hubId,hostname,claim.challenge_hash);
  }
}
