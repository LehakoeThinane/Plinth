import { TenantDatabase } from './tenant.js';

/** Reads global account data for a user already resolved by verified auth.
 * Hub context is supplied for transaction isolation, not account ownership.
 * Provisioning, account linking and organisation/SSO writes are not exposed.
 */
export class IdentityRepository {
  #db;
  #userId;
  constructor(db, verifiedUserId) {
    if (!(db instanceof TenantDatabase)) throw new Error('Tenant database required');
    this.#db=db;
    this.#userId=verifiedUserId;
  }
  async account(hubId) {
    return this.#db.withSnapshot({hubId,userId:this.#userId,orgIds:[],isStaff:false},async tx=>{
      const user=(await tx.query('SELECT id,display_name FROM identity.users')).rows[0];
      if(!user)throw Object.assign(new Error('Not found'),{status:404});
      const organisations=(await tx.query(`SELECT o.id,o.display_name,m.role
        FROM identity.organisations o JOIN identity.org_members m ON m.org_id=o.id
        WHERE m.status='active' ORDER BY o.id`)).rows;
      return {user,organisations};
    });
  }
  async ssoConfiguration(hubId,orgId) {
    return this.#db.withSnapshot({hubId,userId:this.#userId,orgIds:[],isStaff:false},async tx=>{
      const result=await tx.query(`SELECT org_id,protocol,issuer,client_id,metadata_url,enabled
        FROM identity.sso_configurations WHERE org_id=$1`,[orgId]);
      if(!result.rows.length)throw Object.assign(new Error('Not found'),{status:404});
      return result.rows[0];
    });
  }
}
