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
  const identity = await client.query(`
    SELECT c.relname AS name,c.relrowsecurity AS enabled,c.relforcerowsecurity AS forced,
      (SELECT count(*) FROM pg_policy p WHERE p.polrelid=c.oid AND p.polpermissive) AS permissive_count,
      EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid AND p.polpermissive
        AND p.polqual IS NOT NULL AND p.polwithcheck IS NOT NULL
        AND p.polname=CASE c.relname
          WHEN 'organisations' THEN 'member_scope'
          WHEN 'sso_configurations' THEN 'admin_scope'
          WHEN 'org_invitations' THEN 'executor_scope'
          WHEN 'org_events' THEN 'executor_scope' ELSE 'self_scope' END) AS scope_policy
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='identity' AND c.relkind IN ('r','p')
      AND c.relname IN ('users','org_members','organisations','auth_links','sso_configurations','org_invitations','org_events')
  `);
  // Before migration 004 the baseline has two global identity tables.
  const unsafeIdentity=identity.rows.filter(r=>!r.enabled||!r.forced||!r.scope_policy||Number(r.permissive_count)!==1);
  if(unsafeIdentity.length)throw new Error('Unsafe identity policies: '+unsafeIdentity.map(r=>r.name).join(', '));
  const login=await client.query(`
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='identity' AND c.relname='login_attempts'
      AND NOT EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid
        AND p.polname='executor_scope' AND NOT p.polpermissive
        AND p.polqual IS NOT NULL AND p.polwithcheck IS NOT NULL)
  `);
  if(login.rows.length)throw new Error('Unsafe login attempt policies');
  const notices=await client.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='compliance' AND c.relname='notice_publications'
      AND NOT EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid AND p.polname='admin_scope'
        AND NOT p.polpermissive AND p.polqual IS NOT NULL AND p.polwithcheck IS NOT NULL)`);
  if(notices.rows.length)throw new Error('Unsafe notice publication policies');
  const writes=await client.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='compliance' AND c.relname='consent_purposes'
      AND EXISTS(SELECT 1 FROM pg_class h JOIN pg_namespace hn ON hn.oid=h.relnamespace
        WHERE hn.nspname='compliance' AND h.relname='notice_publications')
      AND (NOT EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid AND p.polname='admin_insert'
        AND p.polcmd='a' AND NOT p.polpermissive AND p.polwithcheck IS NOT NULL)
        OR NOT EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid AND p.polname='admin_update'
        AND p.polcmd='w' AND NOT p.polpermissive AND p.polqual IS NOT NULL AND p.polwithcheck IS NOT NULL))`);
  if(writes.rows.length)throw new Error('Unsafe notice publication policies');
  const domains=await client.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='tenancy' AND c.relname='domain_claims'
      AND NOT EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid AND p.polname='admin_scope'
        AND NOT p.polpermissive AND p.polqual IS NOT NULL AND p.polwithcheck IS NOT NULL)`);
  if(domains.rows.length)throw new Error('Unsafe domain claim policies');
  return result.rows.length;
}
