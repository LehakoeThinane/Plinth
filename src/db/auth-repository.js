import { randomUUID } from 'node:crypto';
/** Uses a separate plinth_auth pool: no table access, only explicit auth functions.
 * Verified issuer/subject must come from the managed JWT verifier, never HTTP claims.
 */
export class AuthRepository {
  #pool;
  constructor(authPool) { if(!authPool)throw new Error('Authentication pool required');this.#pool=authPool; }
  async resolveUser(issuer,subject) {
    try {
      return (await this.#pool.query('SELECT app.resolve_auth_user($1,$2,$3) AS id',[issuer,subject,randomUUID()])).rows[0].id;
    }catch(error) {if(error.code==='42501')return null;throw error;}
  }
  async store(hash,session) {
    await this.#pool.query('SELECT app.store_auth_session($1,$2,$3,$4,$5,$6)',
      [hash,session.hubId,session.userId,session.origin,session.csrfToken,session.expiresAt]);
  }
  async read(hash) {
    const row=(await this.#pool.query('SELECT * FROM app.read_auth_session($1)',[hash])).rows[0];
    return row?{userId:row.user_id,hubId:row.hub_id,origin:row.origin,csrfToken:row.csrf_token,expiresAt:new Date(row.expires_at),createdAt:new Date(row.created_at)}:null;
  }
  /** The session hash proves the existing account; issuer/subject come only from a verified callback. */
  async linkIdentity(sessionHash,issuer,subject) {
    try {
      return (await this.#pool.query('SELECT app.link_auth_identity($1,$2,$3,$4) AS outcome',[sessionHash,issuer,subject,randomUUID()])).rows[0].outcome;
    }catch(error) {if(['42501','28000'].includes(error.code))return null;throw error;}
  }
  async unlinkIdentity(sessionHash,{issuer,subject}={}) {
    if(typeof issuer!=='string'||!issuer||issuer.length>2048||typeof subject!=='string'||!subject||subject.length>255)
      throw Object.assign(new Error('Invalid sign-in method'),{status:400});
    try {
      await this.#pool.query('SELECT app.unlink_auth_identity($1,$2,$3,$4)',[sessionHash,issuer,subject,randomUUID()]);
    }catch(error) {
      if(error.code==='28000')throw Object.assign(new Error('Recent sign-in required'),{status:403,reauthenticate:true});
      if(error.code==='42501')throw Object.assign(new Error('Not found'),{status:404});
      if(error.code==='23514')throw Object.assign(new Error('Last sign-in method'),{status:409});
      throw error;
    }
    return {removed:true};
  }
  async delete(hash) { await this.#pool.query('SELECT app.end_auth_session($1)',[hash]); }
  async prune() { await this.#pool.query('SELECT app.prune_auth_sessions()'); }
  async storeLogin(hash,attempt) {
    await this.#pool.query('SELECT app.store_login_attempt($1,$2,$3,$4,$5)',
      [hash,attempt.hubId,attempt.origin,attempt.payload,attempt.expiresAt]);
  }
  async consumeLogin(hash,origin) {
    const row=(await this.#pool.query('SELECT * FROM app.consume_login_attempt($1,$2)',[hash,origin])).rows[0];
    return row?{hubId:row.hub_id,origin:row.origin,payload:row.payload}:null;
  }
  async pruneLogins() { await this.#pool.query('SELECT app.prune_login_attempts()'); }
}
