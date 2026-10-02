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
    return row?{userId:row.user_id,hubId:row.hub_id,origin:row.origin,csrfToken:row.csrf_token,expiresAt:new Date(row.expires_at)}:null;
  }
  async delete(hash) { await this.#pool.query('SELECT app.end_auth_session($1)',[hash]); }
  async prune() { await this.#pool.query('SELECT app.prune_auth_sessions()'); }
}
