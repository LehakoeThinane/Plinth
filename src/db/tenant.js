const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Context is constructed from verified authentication/membership records.
 * Never populate role or organisations directly from request parameters.
 * pool remains private; callers receive a query function only inside a snapshot.
 */
export class TenantDatabase {
  #pool;
  constructor(pool) { this.#pool = pool; }
  async withSnapshot(context, operation) {
    if (!UUID.test(context?.hubId ?? '') ||
        !Array.isArray(context.orgIds) || context.orgIds.some(id => !UUID.test(id)) ||
        typeof context.isStaff !== 'boolean' || (context.userId != null && !UUID.test(context.userId))) throw new Error('Invalid tenant context');
    const client = await this.#pool.connect();
    let broken = false;
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await client.query(
        "SELECT set_config('app.hub_id', $1, true), set_config('app.org_ids', $2, true), set_config('app.is_staff', $3, true)",
        [context.hubId, JSON.stringify(context.orgIds), String(context.isStaff)]);
      await client.query("SELECT set_config('app.user_id',$1,true)",[context.userId ?? '']);
      let active = true;
      try {
        const result = await operation({query: (...args) => {
          if (!active) throw new Error('Tenant transaction has ended');
          return client.query(...args);
        }});
        await client.query('COMMIT');
        return result;
      } finally { active = false; }
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { broken = true; }
      throw error;
    } finally { client.release(broken); }
  }
}
