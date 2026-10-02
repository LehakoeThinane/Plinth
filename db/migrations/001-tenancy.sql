BEGIN;
CREATE SCHEMA app;
CREATE SCHEMA tenancy;
CREATE SCHEMA catalogue;

CREATE FUNCTION app.hub_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.hub_id', true), '')::uuid
$$;
CREATE FUNCTION app.org_ids() RETURNS uuid[] LANGUAGE sql STABLE AS $$
  SELECT coalesce(array(SELECT jsonb_array_elements_text(
    coalesce(nullif(current_setting('app.org_ids', true), ''), '[]')::jsonb)::uuid), '{}'::uuid[])
$$;
CREATE FUNCTION app.is_staff() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(current_setting('app.is_staff', true), '')::boolean, false)
$$;

CREATE TABLE tenancy.hubs (
  id uuid PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  access_epoch bigint NOT NULL DEFAULT 0 CHECK (access_epoch >= 0)
);
CREATE TABLE tenancy.boundaries (
  hub_id uuid NOT NULL REFERENCES tenancy.hubs(id),
  id uuid NOT NULL,
  company_org uuid,
  PRIMARY KEY (hub_id, id)
);
CREATE TABLE catalogue.products (
  hub_id uuid NOT NULL REFERENCES tenancy.hubs(id),
  id uuid NOT NULL,
  boundary_id uuid NOT NULL,
  title text NOT NULL,
  visibility text NOT NULL CHECK (visibility IN ('public','members','company')),
  PRIMARY KEY (hub_id, id),
  UNIQUE (hub_id, id, boundary_id),
  FOREIGN KEY (hub_id, boundary_id) REFERENCES tenancy.boundaries(hub_id, id)
);
CREATE TABLE catalogue.lessons (
  hub_id uuid NOT NULL,
  id uuid NOT NULL,
  product_id uuid NOT NULL,
  boundary_id uuid NOT NULL,
  title text NOT NULL,
  PRIMARY KEY (hub_id, id),
  FOREIGN KEY (hub_id, product_id, boundary_id)
    REFERENCES catalogue.products(hub_id, id, boundary_id)
    ON UPDATE CASCADE
);
-- A non-null boundary key carries company identity. Nullable company_org is
-- never part of the child FK, so clearing it on a lesson cannot bypass the FK.
CREATE FUNCTION app.can_read_boundary(boundary uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM tenancy.boundaries b
    WHERE b.hub_id = app.hub_id() AND b.id = boundary)
$$;
CREATE FUNCTION app.company_visibility_matches(boundary uuid, row_visibility text)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM tenancy.boundaries b
    WHERE b.hub_id = app.hub_id() AND b.id = boundary
    AND ((row_visibility = 'company') = (b.company_org IS NOT NULL)))
$$;

ALTER TABLE tenancy.hubs ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenancy.hubs FORCE ROW LEVEL SECURITY;
CREATE POLICY hub_scope ON tenancy.hubs USING (id = app.hub_id()) WITH CHECK (id = app.hub_id());
ALTER TABLE tenancy.boundaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenancy.boundaries FORCE ROW LEVEL SECURITY;
CREATE POLICY hub_scope ON tenancy.boundaries USING (hub_id = app.hub_id()) WITH CHECK (hub_id = app.hub_id());
CREATE POLICY company_scope ON tenancy.boundaries AS RESTRICTIVE
  USING (company_org IS NULL OR company_org = ANY(app.org_ids()) OR app.is_staff())
  WITH CHECK (company_org IS NULL OR company_org = ANY(app.org_ids()) OR app.is_staff());
ALTER TABLE catalogue.products ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalogue.products FORCE ROW LEVEL SECURITY;
CREATE POLICY hub_scope ON catalogue.products USING (hub_id = app.hub_id()) WITH CHECK (hub_id = app.hub_id());
CREATE POLICY company_scope ON catalogue.products AS RESTRICTIVE
  USING (app.can_read_boundary(boundary_id))
  WITH CHECK (app.can_read_boundary(boundary_id) AND app.company_visibility_matches(boundary_id, visibility));
ALTER TABLE catalogue.lessons ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalogue.lessons FORCE ROW LEVEL SECURITY;
CREATE POLICY hub_scope ON catalogue.lessons USING (hub_id = app.hub_id()) WITH CHECK (hub_id = app.hub_id());
CREATE POLICY company_scope ON catalogue.lessons AS RESTRICTIVE
  USING (app.can_read_boundary(boundary_id)) WITH CHECK (app.can_read_boundary(boundary_id));

GRANT USAGE ON SCHEMA app, tenancy, catalogue TO plinth_app;
GRANT SELECT ON ALL TABLES IN SCHEMA tenancy, catalogue TO plinth_app;
-- Business write permissions require separate service-role policies later.
-- Learner/company identities must not gain catalogue write access through RLS.
GRANT INSERT, UPDATE, DELETE ON catalogue.products, catalogue.lessons TO plinth_app;
CREATE POLICY staff_write ON catalogue.products AS RESTRICTIVE FOR INSERT WITH CHECK (app.is_staff());
CREATE POLICY staff_update ON catalogue.products AS RESTRICTIVE FOR UPDATE USING (app.is_staff()) WITH CHECK (app.is_staff());
CREATE POLICY staff_delete ON catalogue.products AS RESTRICTIVE FOR DELETE USING (app.is_staff());
CREATE POLICY staff_write ON catalogue.lessons AS RESTRICTIVE FOR INSERT WITH CHECK (app.is_staff());
CREATE POLICY staff_update ON catalogue.lessons AS RESTRICTIVE FOR UPDATE USING (app.is_staff()) WITH CHECK (app.is_staff());
CREATE POLICY staff_delete ON catalogue.lessons AS RESTRICTIVE FOR DELETE USING (app.is_staff());
COMMIT;
