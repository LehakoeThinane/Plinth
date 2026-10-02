import { randomBytes,createHash,timingSafeEqual } from 'node:crypto';
const cookieName='__Host-plinth-session';
const digest=value=>createHash('sha256').update(value).digest('hex');
const failure=()=>Object.assign(new Error('Invalid browser session'),{status:401});
function cookie(req) {
  const values=(req.headers.cookie??'').split(';').map(s=>s.trim()).filter(s=>s.startsWith(cookieName+'='));
  if(values.length!==1)return null;
  const value=values[0].slice(cookieName.length+1);
  return /^[0-9a-f]{64}$/.test(value)?value:null;
}
export class BrowserSessions {
  #store;#originForHub;#now;
  constructor({store,originForHub,now=()=>Date.now()}) {
    if(!store||typeof originForHub!=='function')throw new Error('Session store and trusted hub origins required');
    this.#store=store;this.#originForHub=originForHub;this.#now=now;
  }
  async #origin(req,hubId) {
    const value=await this.#originForHub(hubId);
    if(!value)throw failure();
    const url=new URL(value);
    if(url.protocol!=='https:'||url.origin!==value||url.username||url.password||
      req.headers.host?.toLowerCase()!==url.host.toLowerCase())throw failure();
    return url.origin;
  }
  async establish(req,hubId,principal) {
    const origin=await this.#origin(req,hubId);
    if(req.headers.origin!==origin)throw Object.assign(new Error('Origin rejected'),{status:403});
    const expiry=Math.min(new Date(principal.expiresAt).getTime(),this.#now()+60*60*1000);
    if(!Number.isFinite(expiry)||expiry<=this.#now())throw failure();
    const token=randomBytes(32).toString('hex'),csrfToken=randomBytes(32).toString('hex');
    // Replace the current session to prevent fixation and revoke its prior token.
    const old=cookie(req);if(old)await this.#store.delete(digest(old));
    const expiresAt=new Date(expiry);
    await this.#store.store(digest(token),{userId:principal.userId,hubId,origin,csrfToken,expiresAt});
    return {csrfToken,expiresAt,cookie:cookieName+'='+token+'; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age='+Math.floor((expiry-this.#now())/1000)};
  }
  async principal(req) {
    const token=cookie(req);if(!token)return null;
    const session=await this.#store.read(digest(token));
    if(!session || new Date(session.expiresAt).getTime()<=this.#now())return null;
    try {if(await this.#origin(req,session.hubId)!==session.origin)return null;}catch(error){if(error.status===401)return null;throw error;}
    return {...session,sessionHash:digest(token)};
  }
  checkMutation(req,session) {
    const provided=req.headers['x-csrf-token'];
    if(req.headers.origin!==session.origin || typeof provided!=='string'||
      !/^[0-9a-f]{64}$/.test(provided)||!timingSafeEqual(Buffer.from(provided),Buffer.from(session.csrfToken)))
      throw Object.assign(new Error('CSRF rejected'),{status:403});
  }
  async end(req,session) {
    this.checkMutation(req,session);await this.#store.delete(session.sessionHash);
    return cookieName+'=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0';
  }
}
