BEGIN;
CREATE TABLE tenancy.domain_claims (
  hub_id uuid NOT NULL REFERENCES tenancy.hubs(id),
  hostname text NOT NULL CHECK(length(hostname)<=232 AND hostname=lower(hostname)
    AND hostname ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'),
  challenge_hash text NOT NULL CHECK(challenge_hash ~ '^[0-9a-f]{64}$'),
  requested_by uuid NOT NULL REFERENCES identity.users(id),
  expires_at timestamptz NOT NULL DEFAULT (now()+interval '24 hours'),
  PRIMARY KEY(hub_id,hostname)
);
ALTER TABLE tenancy.domain_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenancy.domain_claims FORCE ROW LEVEL SECURITY;
CREATE POLICY hub_scope ON tenancy.domain_claims
  USING(hub_id=app.hub_id()) WITH CHECK(hub_id=app.hub_id());
CREATE POLICY admin_scope ON tenancy.domain_claims AS RESTRICTIVE
  USING(app.is_hub_admin()) WITH CHECK(app.is_hub_admin() AND requested_by=app.user_id());
GRANT SELECT,INSERT,DELETE ON tenancy.domain_claims TO plinth_app;
GRANT UPDATE(challenge_hash,requested_by,expires_at) ON tenancy.domain_claims TO plinth_app;
GRANT DELETE ON tenancy.hub_domains TO plinth_app;
GRANT USAGE ON SCHEMA app,tenancy TO plinth_domain_executor;
GRANT SELECT ON tenancy.memberships TO plinth_domain_executor;
GRANT SELECT,INSERT,UPDATE ON tenancy.hub_domains TO plinth_domain_executor;
GRANT SELECT,DELETE ON tenancy.domain_claims TO plinth_domain_executor;
GRANT USAGE ON SCHEMA app TO plinth_domain_verifier;
CREATE FUNCTION app.confirm_domain(target_hostname text, expected_hash text) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE confirmed timestamptz;
BEGIN
  -- Recheck current caller authority after DNS, then consume the challenge.
  PERFORM 1 FROM tenancy.memberships WHERE hub_id=app.hub_id() AND user_id=app.user_id()
    AND role IN ('owner','admin') AND status='active';
  IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE='42501'; END IF;
  DELETE FROM tenancy.domain_claims WHERE hub_id=app.hub_id() AND hostname=target_hostname
    AND challenge_hash=expected_hash AND expires_at>clock_timestamp();
  IF NOT FOUND THEN RAISE EXCEPTION 'Challenge changed or expired' USING ERRCODE='23514'; END IF;
  INSERT INTO tenancy.hub_domains(hub_id,hostname,verified_at)
    VALUES(app.hub_id(),target_hostname,clock_timestamp())
    ON CONFLICT(hostname) DO UPDATE SET verified_at=excluded.verified_at
      WHERE tenancy.hub_domains.hub_id=app.hub_id()
    RETURNING verified_at INTO confirmed;
  IF confirmed IS NULL THEN RAISE EXCEPTION 'Hostname unavailable' USING ERRCODE='23505'; END IF;
  RETURN confirmed;
END $$;
REVOKE ALL ON FUNCTION app.confirm_domain(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.confirm_domain(text,text) TO plinth_domain_verifier;
GRANT plinth_domain_executor TO CURRENT_USER;
GRANT CREATE ON SCHEMA app TO plinth_domain_executor;
ALTER FUNCTION app.confirm_domain(text,text) OWNER TO plinth_domain_executor;
REVOKE CREATE ON SCHEMA app FROM plinth_domain_executor;
REVOKE plinth_domain_executor FROM CURRENT_USER;
COMMIT;
