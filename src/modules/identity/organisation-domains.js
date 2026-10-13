import { domainHostname,hasTxtProof,resolveDomainTxt } from '../../dns/txt-proof.js';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** DNS ownership of an organisation's domain. Verification is evidence of DNS
 * control only, not of incorporation, employer authority or payment onboarding.
 */
export class OrganisationDomains {
  #repository;#resolve;
  constructor({repository,resolveTxt=resolveDomainTxt}){this.#repository=repository;this.#resolve=resolveTxt;}
  #org(orgId){if(!uuid.test(orgId??''))throw Object.assign(new Error('Invalid organisation'),{status:400});return orgId;}
  list(hubId,orgId){return this.#repository.list(hubId,this.#org(orgId));}
  request(hubId,orgId,input){return this.#repository.request(hubId,this.#org(orgId),domainHostname(input.domain));}
  remove(hubId,orgId,input){return this.#repository.remove(hubId,this.#org(orgId),domainHostname(input.domain));}
  async verify(hubId,orgId,input) {
    const domain=domainHostname(input.domain),hash=await this.#repository.challenge(hubId,this.#org(orgId),domain);
    if(!await hasTxtProof(this.#resolve,domain,'plinth-organisation',hash))throw Object.assign(new Error('DNS proof missing'),{status:409});
    return this.#repository.confirm(hubId,orgId,domain,hash);
  }
}
