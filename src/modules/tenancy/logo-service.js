import { randomUUID } from 'node:crypto';
import { normaliseLogo } from './logo-images.js';
export class LogoService {
  #store;#hubs;
  constructor({store,hubs}) {this.#store=store;this.#hubs=hubs;}
  async authorise(hubId) {
    const member=await this.#hubs.membership(hubId);
    if(!['owner','admin'].includes(member.role))throw Object.assign(new Error('Not found'),{status:404});
  }
  async upload(hubId,input,contentType) {
    await this.authorise(hubId);
    const data=await normaliseLogo(input,contentType),id=randomUUID();
    await this.#store.put(hubId,id,data);
    const logoPath='/assets/hubs/'+hubId+'/branding/'+id+'.webp';
    try{await this.#hubs.brand(hubId,{logoPath});}
    catch(error){await this.#store.delete(hubId,id).catch(()=>{});throw error;}
    return {logoPath};
  }
  async remove(hubId) {await this.authorise(hubId);await this.#hubs.brand(hubId,{logoPath:null});return {logoPath:null};}
}
