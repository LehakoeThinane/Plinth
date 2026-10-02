BEGIN;
ALTER TABLE tenancy.hubs ADD CONSTRAINT safe_slug
  CHECK(slug ~ '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$');
CREATE TABLE tenancy.hub_profiles (
  hub_id uuid PRIMARY KEY REFERENCES tenancy.hubs(id),
  display_name text NOT NULL CHECK(length(display_name) BETWEEN 1 AND 200),
  description text NOT NULL DEFAULT '' CHECK(length(description)<=2000),
  primary_color text NOT NULL DEFAULT '#2456A6' CHECK(primary_color ~ '^#[0-9A-Fa-f]{6}$'),
  font text NOT NULL DEFAULT 'system' CHECK(font IN ('system','serif','sans')),
  logo_path text CHECK(logo_path ~ '^/assets/hubs/[0-9a-f-]{36}/branding/[a-zA-Z0-9_-]+\.(png|jpg|webp)$'
    AND split_part(logo_path,'/',4)=hub_id::text),
  join_mode text NOT NULL DEFAULT 'open' CHECK(join_mode IN ('open','closed'))
);
INSERT INTO tenancy.hub_profiles(hub_id,display_name) SELECT id,slug FROM tenancy.hubs;
CREATE TABLE tenancy.hub_domains (
  hub_id uuid NOT NULL REFERENCES tenancy.hubs(id),
  hostname text PRIMARY KEY CHECK(length(hostname)<=253 AND hostname=lower(hostname)
    AND hostname ~ '^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]*[a-z0-9])?$'),
  verified_at timestamptz
);
CREATE FUNCTION app.is_hub_admin() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS(SELECT 1 FROM tenancy.memberships
    WHERE hub_id=app.hub_id() AND user_id=app.user_id()
    AND status='active' AND role IN ('owner','admin'))
$$;
ALTER TABLE tenancy.hub_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenancy.hub_profiles FORCE ROW LEVEL SECURITY;
CREATE POLICY hub_scope ON tenancy.hub_profiles
  USING(hub_id=app.hub_id()) WITH CHECK(hub_id=app.hub_id());
CREATE POLICY admin_update ON tenancy.hub_profiles AS RESTRICTIVE FOR UPDATE
  USING(app.is_hub_admin()) WITH CHECK(app.is_hub_admin());
ALTER TABLE tenancy.hub_domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenancy.hub_domains FORCE ROW LEVEL SECURITY;
CREATE POLICY hub_scope ON tenancy.hub_domains
  USING(hub_id=app.hub_id()) WITH CHECK(hub_id=app.hub_id());
CREATE POLICY admin_scope ON tenancy.hub_domains AS RESTRICTIVE
  USING(app.is_hub_admin()) WITH CHECK(app.is_hub_admin());

-- This narrow public lookup deliberately crosses hub RLS to resolve a tenant.
-- It returns public branding only, never membership/company/account records.
CREATE FUNCTION app.resolve_hub(target_slug text, target_hostname text)
RETURNS TABLE(id uuid,slug text,display_name text,description text,primary_color text,font text,logo_path text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT h.id,h.slug,p.display_name,p.description,p.primary_color,p.font,p.logo_path
  FROM tenancy.hubs h JOIN tenancy.hub_profiles p ON p.hub_id=h.id
  WHERE ((target_slug IS NOT NULL AND target_hostname IS NULL AND h.slug=target_slug)
    OR (target_slug IS NULL AND target_hostname IS NOT NULL AND EXISTS(
      SELECT 1 FROM tenancy.hub_domains d WHERE d.hub_id=h.id
      AND d.hostname=target_hostname AND d.verified_at IS NOT NULL)))
$$;

CREATE FUNCTION app.create_hub(target_slug text, hub_name text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE target uuid := app.hub_id(); caller uuid := app.user_id();
BEGIN
  IF target IS NULL OR caller IS NULL OR NOT EXISTS(SELECT 1 FROM identity.users WHERE id=caller)
    THEN RAISE EXCEPTION 'Not found' USING ERRCODE='42501'; END IF;
  INSERT INTO tenancy.hubs(id,slug) VALUES(target,target_slug);
  INSERT INTO tenancy.memberships(hub_id,user_id,role,status) VALUES(target,caller,'owner','active');
  INSERT INTO tenancy.hub_profiles(hub_id,display_name) VALUES(target,hub_name);
  RETURN target;
END $$;

CREATE FUNCTION app.join_hub() RETURNS TABLE(role text,status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE target uuid := app.hub_id(); caller uuid := app.user_id(); existing_status text;
BEGIN
  IF caller IS NULL OR NOT EXISTS(SELECT 1 FROM identity.users WHERE id=caller)
    THEN RAISE EXCEPTION 'Not found' USING ERRCODE='42501'; END IF;
  SELECT m.status INTO existing_status FROM tenancy.memberships m
    WHERE m.hub_id=target AND m.user_id=caller;
  IF existing_status IS NOT NULL THEN
    IF existing_status<>'active' THEN RAISE EXCEPTION 'Not found' USING ERRCODE='42501'; END IF;
  ELSE
    -- Lock the join configuration against closing the hub during a join.
    PERFORM 1 FROM tenancy.hub_profiles p WHERE p.hub_id=target AND p.join_mode='open' FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE='42501'; END IF;
    INSERT INTO tenancy.memberships(hub_id,user_id,role,status)
      VALUES(target,caller,'member','active') ON CONFLICT(hub_id,user_id) DO NOTHING;
  END IF;
  RETURN QUERY SELECT m.role,m.status FROM tenancy.memberships m
    WHERE m.hub_id=target AND m.user_id=caller AND m.status='active';
END $$;
REVOKE ALL ON FUNCTION app.resolve_hub(text,text),app.create_hub(text,text),app.join_hub() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resolve_hub(text,text),app.create_hub(text,text),app.join_hub() TO plinth_app;
GRANT SELECT ON tenancy.hub_profiles,tenancy.hub_domains TO plinth_app;
GRANT UPDATE(display_name,description,primary_color,font,logo_path,join_mode) ON tenancy.hub_profiles TO plinth_app;
COMMIT;
