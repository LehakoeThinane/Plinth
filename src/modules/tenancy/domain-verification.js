import { domainHostname,hasTxtProof,resolveDomainTxt } from '../../dns/txt-proof.js';
export { domainDigest,domainHostname,resolveDomainTxt } from '../../dns/txt-proof.js';
export class DomainVerification {
  #repository;#resolve;
  constructor({repository,resolveTxt=resolveDomainTxt}){this.#repository=repository;this.#resolve=resolveTxt;}
  list(hubId){return this.#repository.list(hubId);}
  request(hubId,input){return this.#repository.request(hubId,domainHostname(input.hostname));}
  remove(hubId,input){return this.#repository.remove(hubId,domainHostname(input.hostname));}
  async verify(hubId,input) {
    const hostname=domainHostname(input.hostname),claim=await this.#repository.challenge(hubId,hostname);
    if(!await hasTxtProof(this.#resolve,hostname,'plinth-domain',claim.challenge_hash))throw Object.assign(new Error('DNS proof missing'),{status:409});
    return this.#repository.confirm(hubId,hostname,claim.challenge_hash);
  }
}
