BEGIN;
CREATE TABLE identity.auth_issuers (
  issuer text PRIMARY KEY CHECK(issuer ~ '^https://[^[:space:]]+$'),
  enabled boolean NOT NULL DEFAULT false
);
ALTER TABLE identity.auth_issuers ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.auth_issuers FORCE ROW LEVEL SECURITY;
-- No runtime table policies or grants. Only the authentication role can invoke
-- the narrowly scoped functions; issuer activation requires administration.
CREATE TABLE identity.auth_sessions (
  token_hash text PRIMARY KEY CHECK(token_hash ~ '^[0-9a-f]{64}$'),
  hub_id uuid NOT NULL REFERENCES tenancy.hubs(id),
  user_id uuid NOT NULL REFERENCES identity.users(id),
  origin text NOT NULL CHECK(origin ~ '^https://[^/[:space:]]+$'),
  csrf_token text NOT NULL CHECK(csrf_token ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE identity.auth_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.auth_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY hub_scope ON identity.auth_sessions
  USING(hub_id=app.hub_id()) WITH CHECK(hub_id=app.hub_id());
CREATE POLICY self_scope ON identity.auth_sessions AS RESTRICTIVE
  USING(user_id=app.user_id()) WITH CHECK(user_id=app.user_id());
CREATE INDEX auth_sessions_expiry ON identity.auth_sessions(expires_at);

CREATE FUNCTION app.resolve_auth_user(trusted_issuer text, verified_subject text, candidate_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE resolved uuid;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM identity.auth_issuers WHERE issuer=trusted_issuer AND enabled)
    OR verified_subject IS NULL OR length(verified_subject) NOT BETWEEN 1 AND 255
    THEN RAISE EXCEPTION 'Untrusted identity' USING ERRCODE='42501'; END IF;
  -- Serialise provisioning of one verified identity; email is never a key.
  PERFORM pg_advisory_xact_lock(hashtextextended(trusted_issuer || chr(31) || verified_subject,0));
  SELECT user_id INTO resolved FROM identity.auth_links
    WHERE issuer=trusted_issuer AND subject=verified_subject;
  IF resolved IS NULL THEN
    INSERT INTO identity.users(id) VALUES(candidate_id);
    INSERT INTO identity.auth_links(issuer,subject,user_id)
      VALUES(trusted_issuer,verified_subject,candidate_id);
    resolved := candidate_id;
  END IF;
  RETURN resolved;
END $$;
CREATE FUNCTION app.store_auth_session(hash text, target_hub uuid, caller uuid, host_origin text, csrf text, expiry timestamptz)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF expiry<=now() OR expiry>now()+interval '12 hours' THEN
    RAISE EXCEPTION 'Invalid session expiry' USING ERRCODE='23514'; END IF;
  INSERT INTO identity.auth_sessions(token_hash,hub_id,user_id,origin,csrf_token,expires_at)
    VALUES(hash,target_hub,caller,host_origin,csrf,expiry);
END $$;
CREATE FUNCTION app.read_auth_session(hash text)
RETURNS TABLE(user_id uuid,hub_id uuid,origin text,csrf_token text,expires_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT s.user_id,s.hub_id,s.origin,s.csrf_token,s.expires_at FROM identity.auth_sessions s
    WHERE s.token_hash=hash AND s.expires_at>now()
$$;
CREATE FUNCTION app.end_auth_session(hash text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
  DELETE FROM identity.auth_sessions WHERE token_hash=hash
$$;
CREATE FUNCTION app.prune_auth_sessions() RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
  DELETE FROM identity.auth_sessions WHERE expires_at<=now()
$$;
REVOKE ALL ON FUNCTION app.resolve_auth_user(text,text,uuid),
  app.store_auth_session(text,uuid,uuid,text,text,timestamptz),app.read_auth_session(text),
  app.end_auth_session(text),app.prune_auth_sessions() FROM PUBLIC;
GRANT USAGE ON SCHEMA app TO plinth_auth;
GRANT EXECUTE ON FUNCTION app.resolve_auth_user(text,text,uuid),
  app.store_auth_session(text,uuid,uuid,text,text,timestamptz),app.read_auth_session(text),
  app.end_auth_session(text),app.prune_auth_sessions() TO plinth_auth;
COMMIT;
