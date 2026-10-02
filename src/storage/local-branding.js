import { mkdir,writeFile,readFile,unlink,lstat } from 'node:fs/promises';
import { resolve,join } from 'node:path';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Private development storage, outside the HTTP static root.
 * Deployment owns the root and parent directories; never accept one from HTTP.
 */
export class LocalBrandingStore {
  #root;
  constructor({root}) {if(typeof root!=='string'||!root)throw Error('Private branding root required');this.#root=resolve(root);}
  #path(hubId,id) {
    if(!uuid.test(hubId)||!uuid.test(id))throw Error('Invalid branding storage key');
    return join(this.#root,'hubs',hubId,'branding',id+'.webp');
  }
  async put(hubId,id,data) {
    const path=this.#path(hubId,id);
    if(!Buffer.isBuffer(data)||data.length>512*1024)throw Error('Invalid branding object');
    await mkdir(join(this.#root,'hubs',hubId,'branding'),{recursive:true,mode:0o700});
    await writeFile(path,data,{flag:'wx',mode:0o600});
  }
  async read(hubId,id) {
    const path=this.#path(hubId,id);
    try {
      const stat=await lstat(path);
      if(!stat.isFile()||stat.isSymbolicLink()||stat.size>512*1024)return null;
      return await readFile(path);
    }catch(error){if(error.code==='ENOENT')return null;throw error;}
  }
  async delete(hubId,id) {
    try{await unlink(this.#path(hubId,id));}catch(error){if(error.code!=='ENOENT')throw error;}
  }
}
