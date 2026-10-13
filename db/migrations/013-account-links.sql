BEGIN;
CREATE TABLE identity.account_events (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES identity.users(id),
  action text NOT NULL CHECK(action IN ('linked','unlinked')),
  issuer text NOT NULL CHECK(length(issuer) BETWEEN 1 AND 2048),
  subject text NOT NULL CHECK(length(subject) BETWEEN 1 AND 255),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX account_events_user ON identity.account_events(user_id,created_at);
-- Users read their own sign-in history; only auth functions can append to it.
ALTER TABLE identity.account_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.account_events FORCE ROW LEVEL SECURITY;
CREATE POLICY self_scope ON identity.account_events
  USING(user_id=app.user_id() OR current_user='plinth_auth_executor')
  WITH CHECK(current_user='plinth_auth_executor');
GRANT SELECT ON identity.account_events TO plinth_app;
GRANT SELECT,INSERT ON identity.account_events TO plinth_auth_executor;
GRANT DELETE ON identity.auth_links TO plinth_auth_executor;

-- Sessions now report when they were established so sign-in-method changes
-- can require a recent sign-in.
DROP FUNCTION app.read_auth_session(text);
CREATE FUNCTION app.read_auth_session(hash text)
RETURNS TABLE(user_id uuid,hub_id uuid,origin text,csrf_token text,expires_at timestamptz,created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT s.user_id,s.hub_id,s.origin,s.csrf_token,s.expires_at,s.created_at FROM identity.auth_sessions s
    WHERE s.token_hash=hash AND s.expires_at>now()
$$;

-- The session hash is the proof of the existing account; the verified
-- issuer/subject is the proof of the new sign-in method. A link callback must
-- arrive within the 10-minute start window plus the 10-minute attempt lifetime.
CREATE FUNCTION app.link_auth_identity(p_session text,p_issuer text,p_subject text,p_event uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE caller uuid; existing uuid;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM identity.auth_issuers WHERE issuer=p_issuer AND enabled)
    OR p_subject IS NULL OR length(p_subject) NOT BETWEEN 1 AND 255
    THEN RAISE EXCEPTION 'Untrusted identity' USING ERRCODE='42501'; END IF;
  SELECT s.user_id INTO caller FROM identity.auth_sessions s
    WHERE s.token_hash=p_session AND s.expires_at>now() AND s.created_at>now()-interval '20 minutes';
  IF caller IS NULL THEN RAISE EXCEPTION 'Recent sign-in required' USING ERRCODE='28000'; END IF;
  -- Account lock, then the same identity lock used by provisioning.
  PERFORM pg_advisory_xact_lock(hashtextextended('account-links' || chr(31) || caller::text,0));
  PERFORM pg_advisory_xact_lock(hashtextextended(p_issuer || chr(31) || p_subject,0));
  SELECT l.user_id INTO existing FROM identity.auth_links l WHERE l.issuer=p_issuer AND l.subject=p_subject;
  IF existing=caller THEN RETURN 'unchanged'; END IF;
  -- Never move or merge an identity owned by another account.
  IF existing IS NOT NULL THEN RETURN 'conflict'; END IF;
  INSERT INTO identity.auth_links(issuer,subject,user_id) VALUES(p_issuer,p_subject,caller);
  INSERT INTO identity.account_events(id,user_id,action,issuer,subject) VALUES(p_event,caller,'linked',p_issuer,p_subject);
  RETURN 'linked';
END $$;

CREATE FUNCTION app.unlink_auth_identity(p_session text,p_issuer text,p_subject text,p_event uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE caller uuid;
BEGIN
  SELECT s.user_id INTO caller FROM identity.auth_sessions s
    WHERE s.token_hash=p_session AND s.expires_at>now() AND s.created_at>now()-interval '10 minutes';
  IF caller IS NULL THEN RAISE EXCEPTION 'Recent sign-in required' USING ERRCODE='28000'; END IF;
  -- Serialises concurrent removals so the last method always survives.
  PERFORM pg_advisory_xact_lock(hashtextextended('account-links' || chr(31) || caller::text,0));
  IF NOT EXISTS(SELECT 1 FROM identity.auth_links WHERE issuer=p_issuer AND subject=p_subject AND user_id=caller) THEN
    RAISE EXCEPTION 'Not found' USING ERRCODE='42501';
  END IF;
  IF (SELECT count(*) FROM identity.auth_links WHERE user_id=caller)<=1 THEN
    RAISE EXCEPTION 'Last sign-in method' USING ERRCODE='23514';
  END IF;
  DELETE FROM identity.auth_links WHERE issuer=p_issuer AND subject=p_subject AND user_id=caller;
  -- Sessions do not record their sign-in method, so end every other session.
  DELETE FROM identity.auth_sessions WHERE user_id=caller AND token_hash<>p_session;
  INSERT INTO identity.account_events(id,user_id,action,issuer,subject) VALUES(p_event,caller,'unlinked',p_issuer,p_subject);
END $$;

REVOKE ALL ON FUNCTION app.read_auth_session(text),app.link_auth_identity(text,text,text,uuid),
  app.unlink_auth_identity(text,text,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.read_auth_session(text),app.link_auth_identity(text,text,text,uuid),
  app.unlink_auth_identity(text,text,text,uuid) TO plinth_auth;
GRANT plinth_auth_executor TO CURRENT_USER;
GRANT CREATE ON SCHEMA app TO plinth_auth_executor;
ALTER FUNCTION app.read_auth_session(text) OWNER TO plinth_auth_executor;
ALTER FUNCTION app.link_auth_identity(text,text,text,uuid) OWNER TO plinth_auth_executor;
ALTER FUNCTION app.unlink_auth_identity(text,text,text,uuid) OWNER TO plinth_auth_executor;
REVOKE CREATE ON SCHEMA app FROM plinth_auth_executor;
REVOKE plinth_auth_executor FROM CURRENT_USER;
COMMIT;
