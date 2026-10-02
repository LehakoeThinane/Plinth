BEGIN;
-- Only the current public logo is exposed. No tenant/private asset listing.
GRANT USAGE ON SCHEMA app,tenancy TO plinth_branding_reader;
GRANT SELECT ON tenancy.hub_profiles TO plinth_branding_reader;
ALTER POLICY hub_scope ON tenancy.hub_profiles
  USING(hub_id=app.hub_id() OR current_user='plinth_branding_reader')
  WITH CHECK(hub_id=app.hub_id());
CREATE FUNCTION app.is_published_logo(p_hub uuid,p_file text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT EXISTS(SELECT 1 FROM tenancy.hub_profiles
    WHERE hub_id=p_hub AND p_file ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.webp$'
      AND logo_path='/assets/hubs/'||p_hub::text||'/branding/'||p_file);
$$;
REVOKE ALL ON FUNCTION app.is_published_logo(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.is_published_logo(uuid,text) TO plinth_app;
GRANT plinth_branding_reader TO CURRENT_USER;
GRANT CREATE ON SCHEMA app TO plinth_branding_reader;
ALTER FUNCTION app.is_published_logo(uuid,text) OWNER TO plinth_branding_reader;
REVOKE CREATE ON SCHEMA app FROM plinth_branding_reader;
REVOKE plinth_branding_reader FROM CURRENT_USER;
COMMIT;
