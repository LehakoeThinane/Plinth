BEGIN;
ALTER TABLE catalogue.products
  ADD COLUMN type text NOT NULL DEFAULT 'course' CHECK(type IN ('course','toolkit','programme')),
  ADD COLUMN summary text NOT NULL DEFAULT '' CHECK(length(summary)<=2000),
  -- The shared marketplace (model C) is off at launch; enabling it needs a migration.
  ADD COLUMN marketplace_listed boolean NOT NULL DEFAULT false CHECK(NOT marketplace_listed),
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN published_at timestamptz,
  ADD CONSTRAINT product_title CHECK(length(btrim(title)) BETWEEN 1 AND 200);

CREATE TABLE catalogue.modules (
  hub_id uuid NOT NULL,
  id uuid NOT NULL,
  product_id uuid NOT NULL,
  boundary_id uuid NOT NULL,
  position integer NOT NULL CHECK(position>=0),
  title text NOT NULL CHECK(length(btrim(title)) BETWEEN 1 AND 200),
  PRIMARY KEY(hub_id,id),
  UNIQUE(hub_id,id,product_id,boundary_id),
  UNIQUE(hub_id,product_id,position),
  FOREIGN KEY(hub_id,product_id,boundary_id) REFERENCES catalogue.products(hub_id,id,boundary_id) ON UPDATE CASCADE
);
ALTER TABLE catalogue.lessons
  ADD COLUMN module_id uuid,
  ADD COLUMN position integer NOT NULL DEFAULT 0 CHECK(position>=0),
  ADD COLUMN summary text NOT NULL DEFAULT '' CHECK(length(summary)<=2000),
  -- A lesson's module must belong to the same product and boundary.
  ADD CONSTRAINT lesson_module FOREIGN KEY(hub_id,module_id,product_id,boundary_id)
    REFERENCES catalogue.modules(hub_id,id,product_id,boundary_id) ON UPDATE CASCADE;
CREATE UNIQUE INDEX lesson_position ON catalogue.lessons(hub_id,module_id,position) WHERE module_id IS NOT NULL;

-- Prices are immutable: a change retires the plan and adds a new one, so an
-- order always refers to the price that was shown.
CREATE TABLE catalogue.plans (
  hub_id uuid NOT NULL,
  id uuid NOT NULL,
  product_id uuid NOT NULL,
  boundary_id uuid NOT NULL,
  model text NOT NULL CHECK(model IN ('once_off','subscription','per_seat')),
  amount_cents integer NOT NULL CHECK(amount_cents BETWEEN 100 AND 100000000),
  currency text NOT NULL DEFAULT 'ZAR' CHECK(currency='ZAR'),
  billing_interval text CHECK(billing_interval IN ('month','year')),
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','retired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(hub_id,id),
  CHECK((model='subscription')=(billing_interval IS NOT NULL)),
  FOREIGN KEY(hub_id,product_id,boundary_id) REFERENCES catalogue.products(hub_id,id,boundary_id) ON UPDATE CASCADE
);

ALTER TABLE catalogue.modules ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalogue.modules FORCE ROW LEVEL SECURITY;
ALTER TABLE catalogue.plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalogue.plans FORCE ROW LEVEL SECURITY;
CREATE POLICY hub_scope ON catalogue.modules USING(hub_id=app.hub_id()) WITH CHECK(hub_id=app.hub_id());
CREATE POLICY company_scope ON catalogue.modules AS RESTRICTIVE
  USING(app.can_read_boundary(boundary_id)) WITH CHECK(app.can_read_boundary(boundary_id));
CREATE POLICY hub_scope ON catalogue.plans USING(hub_id=app.hub_id()) WITH CHECK(hub_id=app.hub_id());
CREATE POLICY company_scope ON catalogue.plans AS RESTRICTIVE
  USING(app.can_read_boundary(boundary_id)) WITH CHECK(app.can_read_boundary(boundary_id));

-- Creating catalogue rows needs an active owner/admin, derived from membership
-- rows rather than a session flag. Product/lesson updates keep the existing
-- staff policies; CatalogueRepository sets that flag only after this same check.
CREATE POLICY admin_insert ON catalogue.products AS RESTRICTIVE FOR INSERT WITH CHECK(app.is_hub_admin());
CREATE POLICY admin_insert ON catalogue.lessons AS RESTRICTIVE FOR INSERT WITH CHECK(app.is_hub_admin());
CREATE POLICY admin_insert ON catalogue.modules AS RESTRICTIVE FOR INSERT WITH CHECK(app.is_hub_admin());
CREATE POLICY admin_update ON catalogue.modules AS RESTRICTIVE FOR UPDATE USING(app.is_hub_admin()) WITH CHECK(app.is_hub_admin());
CREATE POLICY admin_insert ON catalogue.plans AS RESTRICTIVE FOR INSERT WITH CHECK(app.is_hub_admin());
CREATE POLICY admin_update ON catalogue.plans AS RESTRICTIVE FOR UPDATE USING(app.is_hub_admin()) WITH CHECK(app.is_hub_admin());
CREATE POLICY admin_insert ON tenancy.boundaries AS RESTRICTIVE FOR INSERT WITH CHECK(app.is_hub_admin());
GRANT INSERT ON tenancy.boundaries TO plinth_app;
GRANT SELECT,INSERT ON catalogue.modules TO plinth_app;
GRANT UPDATE(title) ON catalogue.modules TO plinth_app;
GRANT SELECT,INSERT ON catalogue.plans TO plinth_app;
GRANT UPDATE(status) ON catalogue.plans TO plinth_app;

CREATE FUNCTION app.guard_product() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'draft' THEN RAISE EXCEPTION 'Products start as drafts' USING ERRCODE='23514'; END IF;
    NEW.published_at:=NULL;
    RETURN NEW;
  END IF;
  IF NEW.type<>OLD.type OR NEW.visibility<>OLD.visibility OR NEW.boundary_id<>OLD.boundary_id OR NEW.created_at<>OLD.created_at THEN
    RAISE EXCEPTION 'Product type and visibility are fixed' USING ERRCODE='23514';
  END IF;
  IF OLD.status='published' AND NEW.status<>'published' THEN
    RAISE EXCEPTION 'Published products cannot be withdrawn yet' USING ERRCODE='23514';
  END IF;
  IF OLD.status='published' AND NEW.access_mode<>OLD.access_mode THEN
    RAISE EXCEPTION 'Access mode is fixed once published' USING ERRCODE='23514';
  END IF;
  IF NEW.status='published' AND OLD.status<>'published' THEN
    IF NOT EXISTS(SELECT 1 FROM catalogue.lessons WHERE hub_id=NEW.hub_id AND product_id=NEW.id) THEN
      RAISE EXCEPTION 'A product needs a lesson before publishing' USING ERRCODE='23514';
    END IF;
    IF NEW.access_mode='entitled' AND NEW.visibility<>'company' AND NOT EXISTS(SELECT 1 FROM catalogue.plans
      WHERE hub_id=NEW.hub_id AND product_id=NEW.id AND status='active') THEN
      RAISE EXCEPTION 'A paid product needs an active price before publishing' USING ERRCODE='23514';
    END IF;
    NEW.published_at:=now();
  END IF;
  NEW.updated_at:=now();
  RETURN NEW;
END $$;
CREATE TRIGGER product_guard BEFORE INSERT OR UPDATE ON catalogue.products
  FOR EACH ROW EXECUTE FUNCTION app.guard_product();

CREATE FUNCTION app.guard_plan() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'active' THEN RAISE EXCEPTION 'Plans start active' USING ERRCODE='23514'; END IF;
    -- Company products are paid for off the platform and use seat grants.
    IF EXISTS(SELECT 1 FROM catalogue.products WHERE hub_id=NEW.hub_id AND id=NEW.product_id AND visibility='company') THEN
      RAISE EXCEPTION 'Company products have no prices' USING ERRCODE='23514';
    END IF;
  ELSIF OLD.status<>'active' OR NEW.status<>'retired' THEN
    RAISE EXCEPTION 'Plans can only be retired' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER plan_guard BEFORE INSERT OR UPDATE ON catalogue.plans
  FOR EACH ROW EXECUTE FUNCTION app.guard_plan();
REVOKE ALL ON FUNCTION app.guard_product(),app.guard_plan() FROM PUBLIC;
COMMIT;
