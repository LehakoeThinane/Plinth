BEGIN;
ALTER TABLE identity.users ADD COLUMN display_name text CHECK (length(display_name) BETWEEN 1 AND 200);
CREATE TABLE identity.organisations (
  id uuid PRIMARY KEY,
  display_name text CHECK (length(display_name) BETWEEN 1 AND 200)
);
-- Preserve existing organisation identifiers without inventing company names.
INSERT INTO identity.organisations(id)
  SELECT org_id FROM identity.org_members UNION
  SELECT company_org FROM tenancy.boundaries WHERE company_org IS NOT NULL;
ALTER TABLE identity.org_members ADD CONSTRAINT organisation_fk
  FOREIGN KEY(org_id) REFERENCES identity.organisations(id);
ALTER TABLE tenancy.boundaries ADD CONSTRAINT boundary_organisation_fk
  FOREIGN KEY(company_org) REFERENCES identity.organisations(id);
ALTER TABLE identity.org_members ADD COLUMN role text NOT NULL DEFAULT 'member'
  CHECK(role IN ('admin','member'));

CREATE TABLE identity.auth_links (
  issuer text NOT NULL CHECK (length(issuer) BETWEEN 1 AND 2048),
  subject text NOT NULL CHECK (length(subject) BETWEEN 1 AND 255),
  user_id uuid NOT NULL REFERENCES identity.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(issuer,subject)
);
-- Account linking is an administrative/auth-service operation. Never link by
-- email alone or trust user-supplied user_id/organisation claims.
ALTER TABLE identity.auth_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.auth_links FORCE ROW LEVEL SECURITY;
CREATE POLICY self_scope ON identity.auth_links
  USING(user_id=app.user_id()) WITH CHECK(user_id=app.user_id());

CREATE FUNCTION app.is_org_member(target uuid, admin_only boolean DEFAULT false)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS(SELECT 1 FROM identity.org_members
    WHERE user_id=app.user_id() AND org_id=target AND status='active'
      AND (NOT admin_only OR role='admin'))
$$;
ALTER TABLE identity.organisations ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.organisations FORCE ROW LEVEL SECURITY;
CREATE POLICY member_scope ON identity.organisations
  USING(app.is_org_member(id)) WITH CHECK(app.is_org_member(id,true));

CREATE TABLE identity.sso_configurations (
  org_id uuid PRIMARY KEY REFERENCES identity.organisations(id),
  protocol text NOT NULL CHECK(protocol IN ('oidc','saml')),
  issuer text NOT NULL CHECK(length(issuer) BETWEEN 1 AND 2048),
  client_id text CHECK(length(client_id) BETWEEN 1 AND 255),
  metadata_url text CHECK(metadata_url ~ '^https://[^[:space:]]+$'),
  enabled boolean NOT NULL DEFAULT false CHECK(NOT enabled),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(protocol <> 'oidc' OR client_id IS NOT NULL),
  CHECK(protocol <> 'saml' OR metadata_url IS NOT NULL)
);
-- Configuration foundation only: no secrets stored here and no remote metadata
-- fetched. Enabling SSO needs a later integration and migration.
ALTER TABLE identity.sso_configurations ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.sso_configurations FORCE ROW LEVEL SECURITY;
CREATE POLICY admin_scope ON identity.sso_configurations
  USING(app.is_org_member(org_id,true)) WITH CHECK(app.is_org_member(org_id,true));
GRANT SELECT ON identity.organisations,identity.auth_links,identity.sso_configurations TO plinth_app;
COMMIT;
