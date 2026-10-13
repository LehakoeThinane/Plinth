BEGIN;
CREATE TABLE identity.org_domain_claims (
  org_id uuid NOT NULL REFERENCES identity.organisations(id),
  domain text NOT NULL CHECK(length(domain)<=232 AND domain=lower(domain)
    AND domain ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'),
  challenge_hash text NOT NULL CHECK(challenge_hash ~ '^[0-9a-f]{64}$'),
  requested_by uuid NOT NULL REFERENCES identity.users(id),
  expires_at timestamptz NOT NULL DEFAULT (now()+interval '24 hours'),
  PRIMARY KEY(org_id,domain)
);
-- A verified domain belongs to exactly one organisation.
CREATE TABLE identity.org_domains (
  domain text PRIMARY KEY CHECK(length(domain)<=232 AND domain=lower(domain)),
  org_id uuid NOT NULL REFERENCES identity.organisations(id),
  verified_by uuid NOT NULL REFERENCES identity.users(id),
  verified_at timestamptz NOT NULL
);
CREATE INDEX org_domains_org ON identity.org_domains(org_id);
ALTER TABLE identity.org_domain_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.org_domain_claims FORCE ROW LEVEL SECURITY;
CREATE POLICY executor_scope ON identity.org_domain_claims
  USING(current_user='plinth_identity_executor') WITH CHECK(current_user='plinth_identity_executor');
ALTER TABLE identity.org_domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.org_domains FORCE ROW LEVEL SECURITY;
CREATE POLICY member_scope ON identity.org_domains
  USING(app.is_org_member(org_id) OR current_user='plinth_identity_executor')
  WITH CHECK(current_user='plinth_identity_executor');
GRANT SELECT ON identity.org_domains TO plinth_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON identity.org_domain_claims,identity.org_domains TO plinth_identity_executor;
ALTER TABLE identity.org_events DROP CONSTRAINT org_events_action_check;
ALTER TABLE identity.org_events ADD CONSTRAINT org_events_action_check CHECK(action IN ('created','renamed','invited',
  'invite_revoked','accepted','removed','role_changed','domain_requested','domain_verified','domain_removed'));

-- Admin authority and the organisation revision lock, shared by every domain write.
CREATE FUNCTION app.lock_org_admin(p_org uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  UPDATE identity.organisations SET revision=revision+1 WHERE id=p_org;
  IF NOT FOUND OR NOT app.is_org_member(p_org,true) THEN RAISE EXCEPTION 'Not found' USING ERRCODE='42501'; END IF;
END $$;

CREATE FUNCTION app.request_org_domain(p_org uuid,p_domain text,p_hash text,p_event uuid) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE expiry timestamptz;
BEGIN
  PERFORM app.lock_org_admin(p_org);
  INSERT INTO identity.org_domain_claims(org_id,domain,challenge_hash,requested_by) VALUES(p_org,p_domain,p_hash,app.user_id())
    ON CONFLICT(org_id,domain) DO UPDATE SET challenge_hash=excluded.challenge_hash,requested_by=excluded.requested_by,
      expires_at=now()+interval '24 hours'
    RETURNING expires_at INTO expiry;
  INSERT INTO identity.org_events(id,org_id,actor_user,action,details)
    VALUES(p_event,p_org,app.user_id(),'domain_requested',jsonb_build_object('domain',p_domain));
  RETURN expiry;
END $$;

CREATE FUNCTION app.org_domain_challenge(p_org uuid,p_domain text) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE result text;
BEGIN
  IF NOT app.is_org_member(p_org,true) THEN RAISE EXCEPTION 'Not found' USING ERRCODE='42501'; END IF;
  SELECT challenge_hash INTO result FROM identity.org_domain_claims
    WHERE org_id=p_org AND domain=p_domain AND expires_at>clock_timestamp();
  IF result IS NULL THEN RAISE EXCEPTION 'No current challenge' USING ERRCODE='23514'; END IF;
  RETURN result;
END $$;

-- Executed only by the DNS verifier login after it has checked the TXT proof.
CREATE FUNCTION app.confirm_org_domain(p_org uuid,p_domain text,p_hash text,p_event uuid) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE confirmed timestamptz;
BEGIN
  -- Recheck current authority after DNS, then consume the exact current challenge.
  PERFORM app.lock_org_admin(p_org);
  DELETE FROM identity.org_domain_claims WHERE org_id=p_org AND domain=p_domain
    AND challenge_hash=p_hash AND expires_at>clock_timestamp();
  IF NOT FOUND THEN RAISE EXCEPTION 'Challenge changed or expired' USING ERRCODE='23514'; END IF;
  INSERT INTO identity.org_domains(domain,org_id,verified_by,verified_at)
    VALUES(p_domain,p_org,app.user_id(),clock_timestamp())
    ON CONFLICT(domain) DO UPDATE SET verified_by=excluded.verified_by,verified_at=excluded.verified_at
      WHERE identity.org_domains.org_id=p_org
    RETURNING verified_at INTO confirmed;
  IF confirmed IS NULL THEN RAISE EXCEPTION 'Domain unavailable' USING ERRCODE='23505'; END IF;
  INSERT INTO identity.org_events(id,org_id,actor_user,action,details)
    VALUES(p_event,p_org,app.user_id(),'domain_verified',jsonb_build_object('domain',p_domain));
  RETURN confirmed;
END $$;

CREATE FUNCTION app.remove_org_domain(p_org uuid,p_domain text,p_event uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE claims integer; verified integer;
BEGIN
  PERFORM app.lock_org_admin(p_org);
  DELETE FROM identity.org_domain_claims WHERE org_id=p_org AND domain=p_domain;
  GET DIAGNOSTICS claims=ROW_COUNT;
  DELETE FROM identity.org_domains WHERE org_id=p_org AND domain=p_domain;
  GET DIAGNOSTICS verified=ROW_COUNT;
  IF claims+verified=0 THEN RAISE EXCEPTION 'Not found' USING ERRCODE='42501'; END IF;
  INSERT INTO identity.org_events(id,org_id,actor_user,action,details)
    VALUES(p_event,p_org,app.user_id(),'domain_removed',jsonb_build_object('domain',p_domain));
END $$;

CREATE FUNCTION app.organisation_domains(p_org uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF NOT app.is_org_member(p_org,true) THEN RAISE EXCEPTION 'Not found' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object(
    'claims',COALESCE((SELECT jsonb_agg(jsonb_build_object('domain',domain,'expiresAt',expires_at) ORDER BY domain)
      FROM identity.org_domain_claims WHERE org_id=p_org),'[]'::jsonb),
    'verified',COALESCE((SELECT jsonb_agg(jsonb_build_object('domain',domain,'verifiedAt',verified_at) ORDER BY domain)
      FROM identity.org_domains WHERE org_id=p_org),'[]'::jsonb));
END $$;

REVOKE ALL ON FUNCTION app.lock_org_admin(uuid),app.request_org_domain(uuid,text,text,uuid),
  app.org_domain_challenge(uuid,text),app.confirm_org_domain(uuid,text,text,uuid),
  app.remove_org_domain(uuid,text,uuid),app.organisation_domains(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.request_org_domain(uuid,text,text,uuid),app.org_domain_challenge(uuid,text),
  app.remove_org_domain(uuid,text,uuid),app.organisation_domains(uuid) TO plinth_app;
GRANT EXECUTE ON FUNCTION app.confirm_org_domain(uuid,text,text,uuid) TO plinth_domain_verifier;
GRANT plinth_identity_executor TO CURRENT_USER;
GRANT CREATE ON SCHEMA app TO plinth_identity_executor;
ALTER FUNCTION app.lock_org_admin(uuid) OWNER TO plinth_identity_executor;
ALTER FUNCTION app.request_org_domain(uuid,text,text,uuid) OWNER TO plinth_identity_executor;
ALTER FUNCTION app.org_domain_challenge(uuid,text) OWNER TO plinth_identity_executor;
ALTER FUNCTION app.confirm_org_domain(uuid,text,text,uuid) OWNER TO plinth_identity_executor;
ALTER FUNCTION app.remove_org_domain(uuid,text,uuid) OWNER TO plinth_identity_executor;
ALTER FUNCTION app.organisation_domains(uuid) OWNER TO plinth_identity_executor;
REVOKE CREATE ON SCHEMA app FROM plinth_identity_executor;
REVOKE plinth_identity_executor FROM CURRENT_USER;
COMMIT;
