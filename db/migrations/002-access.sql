BEGIN;
CREATE SCHEMA identity;
CREATE SCHEMA access;
CREATE TABLE identity.users (id uuid PRIMARY KEY, access_version bigint NOT NULL DEFAULT 0);
CREATE TABLE identity.org_members (user_id uuid NOT NULL REFERENCES identity.users(id), org_id uuid NOT NULL, status text NOT NULL CHECK (status IN ('active','ended')), PRIMARY KEY(user_id,org_id));
CREATE TABLE tenancy.memberships (hub_id uuid NOT NULL REFERENCES tenancy.hubs(id), user_id uuid NOT NULL REFERENCES identity.users(id), role text NOT NULL CHECK (role IN ('owner','admin','facilitator','staff','member')), status text NOT NULL CHECK (status IN ('active','suspended','ended')), PRIMARY KEY(hub_id,user_id));
CREATE TABLE access.entitlements (hub_id uuid NOT NULL REFERENCES tenancy.hubs(id), id uuid NOT NULL, user_id uuid NOT NULL REFERENCES identity.users(id), target_id uuid NOT NULL, kind text NOT NULL DEFAULT 'product' CHECK(kind IN ('product','tier')), expires_at timestamptz, revoked boolean NOT NULL DEFAULT false, PRIMARY KEY(hub_id,id));
CREATE TABLE access.tier_benefits (hub_id uuid NOT NULL REFERENCES tenancy.hubs(id), tier_id uuid NOT NULL, target_id uuid NOT NULL, PRIMARY KEY(hub_id,tier_id,target_id));
ALTER TABLE catalogue.products ADD COLUMN status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published','archived'));
ALTER TABLE catalogue.products ADD COLUMN access_mode text NOT NULL DEFAULT 'entitled' CHECK(access_mode IN ('open','members','entitled'));
ALTER TABLE catalogue.lessons ADD COLUMN status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published','archived'));
ALTER TABLE catalogue.lessons ADD COLUMN access_mode text NOT NULL DEFAULT 'open' CHECK(access_mode IN ('open','members','entitled'));
ALTER TABLE catalogue.lessons ADD COLUMN preview_available boolean NOT NULL DEFAULT false;
CREATE FUNCTION app.user_id() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.user_id',true),'')::uuid $$;
ALTER TABLE identity.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.users FORCE ROW LEVEL SECURITY;
CREATE POLICY self_scope ON identity.users USING(id=app.user_id()) WITH CHECK(id=app.user_id());
ALTER TABLE identity.org_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.org_members FORCE ROW LEVEL SECURITY;
CREATE POLICY self_scope ON identity.org_members USING(user_id=app.user_id()) WITH CHECK(user_id=app.user_id());
ALTER TABLE tenancy.memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenancy.memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY hub_scope ON tenancy.memberships USING(hub_id=app.hub_id()) WITH CHECK(hub_id=app.hub_id());
CREATE POLICY self_scope ON tenancy.memberships AS RESTRICTIVE USING(user_id=app.user_id()) WITH CHECK(user_id=app.user_id());
ALTER TABLE access.entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE access.entitlements FORCE ROW LEVEL SECURITY;
CREATE POLICY hub_scope ON access.entitlements USING(hub_id=app.hub_id()) WITH CHECK(hub_id=app.hub_id());
CREATE POLICY self_scope ON access.entitlements AS RESTRICTIVE USING(user_id=app.user_id()) WITH CHECK(user_id=app.user_id());
ALTER TABLE access.tier_benefits ENABLE ROW LEVEL SECURITY;
ALTER TABLE access.tier_benefits FORCE ROW LEVEL SECURITY;
CREATE POLICY hub_scope ON access.tier_benefits USING(hub_id=app.hub_id()) WITH CHECK(hub_id=app.hub_id());
-- Version maintenance applies even to administrative writes. Runtime has no
-- mutation grants on identity, memberships or entitlements in this increment.
CREATE FUNCTION app.bump_user_access() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN UPDATE identity.users SET access_version=access_version+1 WHERE id=OLD.user_id; END IF;
  IF TG_OP='INSERT' OR (TG_OP='UPDATE' AND NEW.user_id IS DISTINCT FROM OLD.user_id) THEN
    UPDATE identity.users SET access_version=access_version+1 WHERE id=NEW.user_id;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER membership_version AFTER INSERT OR UPDATE OR DELETE ON tenancy.memberships FOR EACH ROW EXECUTE FUNCTION app.bump_user_access();
CREATE TRIGGER organisation_version AFTER INSERT OR UPDATE OR DELETE ON identity.org_members FOR EACH ROW EXECUTE FUNCTION app.bump_user_access();
CREATE TRIGGER entitlement_version AFTER INSERT OR UPDATE OR DELETE ON access.entitlements FOR EACH ROW EXECUTE FUNCTION app.bump_user_access();
CREATE FUNCTION app.bump_hub_epoch() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN UPDATE tenancy.hubs SET access_epoch=access_epoch+1 WHERE id=OLD.hub_id; END IF;
  IF TG_OP='INSERT' OR (TG_OP='UPDATE' AND NEW.hub_id IS DISTINCT FROM OLD.hub_id) THEN UPDATE tenancy.hubs SET access_epoch=access_epoch+1 WHERE id=NEW.hub_id; END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER product_epoch AFTER INSERT OR UPDATE OR DELETE ON catalogue.products FOR EACH ROW EXECUTE FUNCTION app.bump_hub_epoch();
CREATE TRIGGER lesson_epoch AFTER INSERT OR UPDATE OR DELETE ON catalogue.lessons FOR EACH ROW EXECUTE FUNCTION app.bump_hub_epoch();
CREATE TRIGGER boundary_epoch AFTER INSERT OR UPDATE OR DELETE ON tenancy.boundaries FOR EACH ROW EXECUTE FUNCTION app.bump_hub_epoch();
CREATE TRIGGER tier_epoch AFTER INSERT OR UPDATE OR DELETE ON access.tier_benefits FOR EACH ROW EXECUTE FUNCTION app.bump_hub_epoch();
REVOKE ALL ON FUNCTION app.bump_user_access(),app.bump_hub_epoch() FROM PUBLIC;
GRANT USAGE ON SCHEMA identity,access TO plinth_app;
GRANT SELECT ON ALL TABLES IN SCHEMA identity,access TO plinth_app;
GRANT SELECT ON tenancy.memberships TO plinth_app;
COMMIT;
