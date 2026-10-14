BEGIN;
CREATE SCHEMA commerce;
-- A hub has zero, one or many ranked tiers. Subscriptions (payments) come later;
-- holding a tier is an access.entitlements row of kind 'tier'.
CREATE TABLE commerce.tiers (
  hub_id uuid NOT NULL REFERENCES tenancy.hubs(id),
  id uuid NOT NULL,
  name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 80),
  description text NOT NULL DEFAULT '' CHECK(length(description)<=2000),
  rank integer NOT NULL CHECK(rank BETWEEN 1 AND 100),
  amount_cents integer NOT NULL CHECK(amount_cents BETWEEN 100 AND 100000000),
  currency text NOT NULL DEFAULT 'ZAR' CHECK(currency='ZAR'),
  billing_interval text NOT NULL CHECK(billing_interval IN ('month','year')),
  status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published','archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  PRIMARY KEY(hub_id,id)
);
-- Ranks order upgrades and downgrades among the tiers still on offer.
CREATE UNIQUE INDEX tier_rank ON commerce.tiers(hub_id,rank) WHERE status<>'archived';
ALTER TABLE commerce.tiers ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce.tiers FORCE ROW LEVEL SECURITY;
CREATE POLICY hub_scope ON commerce.tiers USING(hub_id=app.hub_id()) WITH CHECK(hub_id=app.hub_id());
CREATE POLICY admin_insert ON commerce.tiers AS RESTRICTIVE FOR INSERT WITH CHECK(app.is_hub_admin());
CREATE POLICY admin_update ON commerce.tiers AS RESTRICTIVE FOR UPDATE USING(app.is_hub_admin()) WITH CHECK(app.is_hub_admin());

-- Benefits are typed and must name a real item of the right kind in the hub.
ALTER TABLE access.tier_benefits ADD COLUMN target_type text CHECK(target_type IN ('product','space','library'));
UPDATE access.tier_benefits SET target_type='product' WHERE target_type IS NULL;
ALTER TABLE access.tier_benefits ALTER COLUMN target_type SET NOT NULL;
ALTER TABLE access.tier_benefits ADD CONSTRAINT tier_benefit_tier FOREIGN KEY(hub_id,tier_id) REFERENCES commerce.tiers(hub_id,id) NOT VALID;
CREATE POLICY admin_insert ON access.tier_benefits AS RESTRICTIVE FOR INSERT WITH CHECK(app.is_hub_admin());
CREATE POLICY admin_delete ON access.tier_benefits AS RESTRICTIVE FOR DELETE USING(app.is_hub_admin());

CREATE FUNCTION app.guard_tier() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'draft' THEN RAISE EXCEPTION 'Tiers start as drafts' USING ERRCODE='23514'; END IF;
    NEW.published_at:=NULL;
    RETURN NEW;
  END IF;
  IF NEW.hub_id<>OLD.hub_id OR NEW.id<>OLD.id OR NEW.created_at<>OLD.created_at THEN
    RAISE EXCEPTION 'Tier identity is fixed' USING ERRCODE='23514';
  END IF;
  -- Subscribers will hold the published price; changing it needs a new tier.
  IF OLD.status<>'draft' AND (NEW.amount_cents<>OLD.amount_cents OR NEW.billing_interval<>OLD.billing_interval) THEN
    RAISE EXCEPTION 'Published tier prices are fixed' USING ERRCODE='23514';
  END IF;
  IF NEW.status='draft' AND OLD.status<>'draft' THEN RAISE EXCEPTION 'Tiers cannot return to draft' USING ERRCODE='23514'; END IF;
  IF OLD.status='archived' AND NEW.status<>'archived' THEN RAISE EXCEPTION 'Archived tiers stay archived' USING ERRCODE='23514'; END IF;
  IF NEW.status='published' AND OLD.status='draft' THEN NEW.published_at:=now(); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tier_guard BEFORE INSERT OR UPDATE ON commerce.tiers FOR EACH ROW EXECUTE FUNCTION app.guard_tier();
-- Definer rights so the check sees company products and spaces the caller's
-- row-level security would hide.
CREATE FUNCTION app.guard_tier_benefit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE valid boolean;
BEGIN
  valid:=CASE NEW.target_type
    WHEN 'product' THEN EXISTS(SELECT 1 FROM catalogue.products WHERE hub_id=NEW.hub_id AND id=NEW.target_id
      AND access_mode='entitled' AND visibility<>'company')
    WHEN 'space' THEN EXISTS(SELECT 1 FROM community.spaces WHERE hub_id=NEW.hub_id AND id=NEW.target_id AND visibility='tier')
    WHEN 'library' THEN EXISTS(SELECT 1 FROM library.items WHERE hub_id=NEW.hub_id AND id=NEW.target_id AND visibility IN ('tier','entitled'))
    ELSE false END;
  IF NOT valid THEN
    RAISE EXCEPTION 'A tier benefit must name a paid product, tier space or tier/buyer library item' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tier_benefit_guard BEFORE INSERT OR UPDATE ON access.tier_benefits FOR EACH ROW EXECUTE FUNCTION app.guard_tier_benefit();
REVOKE ALL ON FUNCTION app.guard_tier(),app.guard_tier_benefit() FROM PUBLIC;
GRANT USAGE ON SCHEMA commerce TO plinth_app;
GRANT SELECT,INSERT ON commerce.tiers TO plinth_app;
GRANT UPDATE(name,description,rank,amount_cents,billing_interval,status) ON commerce.tiers TO plinth_app;
GRANT INSERT,DELETE ON access.tier_benefits TO plinth_app;
COMMIT;
