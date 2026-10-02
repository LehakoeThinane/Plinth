export async function auditPolicies(client) {
  const result = await client.query(`
    SELECT n.nspname AS schema, c.relname AS name, c.relrowsecurity AS enabled,
      c.relforcerowsecurity AS forced,
      (SELECT count(*) FROM pg_policy p WHERE p.polrelid=c.oid AND p.polpermissive) AS permissive_count,
      EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid
        AND p.polname='hub_scope' AND p.polpermissive
        AND p.polqual IS NOT NULL AND p.polwithcheck IS NOT NULL) AS hub_policy,
      EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid
        AND p.polname='company_scope' AND NOT p.polpermissive
        AND p.polqual IS NOT NULL AND p.polwithcheck IS NOT NULL) AS company_policy,
      EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid
        AND a.attname IN ('boundary_id','company_org') AND NOT a.attisdropped) AS company_owned
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema')
      AND (EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid
        AND a.attname='hub_id' AND NOT a.attisdropped)
        OR (n.nspname='tenancy' AND c.relname='hubs'))
  `);
  const failures = result.rows.filter(row => !row.enabled || !row.forced ||
    !row.hub_policy || Number(row.permissive_count) !== 1 || (row.company_owned && !row.company_policy));
  if (failures.length) throw new Error('Unsafe tenant policies: ' + failures.map(r=>r.schema+'.'+r.name).join(', '));
  if (!result.rows.length) throw new Error('No tenant schema found');
  return result.rows.length;
}
