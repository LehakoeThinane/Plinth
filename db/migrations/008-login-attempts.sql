BEGIN;
CREATE TABLE identity.login_attempts (
  state_hash text PRIMARY KEY CHECK(state_hash ~ '^[0-9a-f]{64}$'),
  hub_id uuid NOT NULL REFERENCES tenancy.hubs(id),
  origin text NOT NULL CHECK(origin ~ '^https://[^/?#@]+$'),
  payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object' AND octet_length(payload::text)<=4096),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_attempt_expiry ON identity.login_attempts(expires_at);
ALTER TABLE identity.login_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.login_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY hub_scope ON identity.login_attempts
  USING(hub_id=app.hub_id() OR current_user='plinth_auth_executor')
  WITH CHECK(hub_id=app.hub_id() OR current_user='plinth_auth_executor');
CREATE POLICY executor_scope ON identity.login_attempts AS RESTRICTIVE
  USING(current_user='plinth_auth_executor') WITH CHECK(current_user='plinth_auth_executor');
GRANT SELECT,INSERT,DELETE ON identity.login_attempts TO plinth_auth_executor;
CREATE FUNCTION app.store_login_attempt(p_hash text,p_hub uuid,p_origin text,p_payload jsonb,p_expiry timestamptz)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  -- Tolerate small application/database clock differences, but never store an
  -- attempt beyond ten minutes on the authoritative database clock.
  IF p_expiry<=now() OR p_expiry>now()+interval '11 minutes' THEN
    RAISE EXCEPTION 'Invalid login expiry' USING ERRCODE='22023';
  END IF;
  INSERT INTO identity.login_attempts(state_hash,hub_id,origin,payload,expires_at)
    VALUES(p_hash,p_hub,p_origin,p_payload,LEAST(p_expiry,now()+interval '10 minutes'));
END;
$$;
CREATE FUNCTION app.consume_login_attempt(p_hash text,p_origin text)
RETURNS TABLE(hub_id uuid,origin text,payload jsonb)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
  DELETE FROM identity.login_attempts a
  WHERE a.state_hash=p_hash AND a.origin=p_origin AND a.expires_at>now()
  RETURNING a.hub_id,a.origin,a.payload;
$$;
CREATE FUNCTION app.prune_login_attempts() RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
  DELETE FROM identity.login_attempts WHERE expires_at<=now();
$$;
REVOKE ALL ON FUNCTION app.store_login_attempt(text,uuid,text,jsonb,timestamptz),
  app.consume_login_attempt(text,text),app.prune_login_attempts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.store_login_attempt(text,uuid,text,jsonb,timestamptz),
  app.consume_login_attempt(text,text),app.prune_login_attempts() TO plinth_auth;
GRANT plinth_auth_executor TO CURRENT_USER;
GRANT CREATE ON SCHEMA app TO plinth_auth_executor;
ALTER FUNCTION app.store_login_attempt(text,uuid,text,jsonb,timestamptz) OWNER TO plinth_auth_executor;
ALTER FUNCTION app.consume_login_attempt(text,text) OWNER TO plinth_auth_executor;
ALTER FUNCTION app.prune_login_attempts() OWNER TO plinth_auth_executor;
REVOKE CREATE ON SCHEMA app FROM plinth_auth_executor;
REVOKE plinth_auth_executor FROM CURRENT_USER;
COMMIT;
