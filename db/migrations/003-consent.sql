BEGIN;
CREATE SCHEMA compliance;
CREATE TABLE compliance.consent_purposes (
  hub_id uuid NOT NULL REFERENCES tenancy.hubs(id),
  purpose text NOT NULL CHECK (purpose ~ '^[a-z][a-z0-9_]{0,63}$'),
  notice_version text NOT NULL CHECK (length(notice_version) BETWEEN 1 AND 100),
  notice_text text NOT NULL CHECK (length(notice_text) BETWEEN 1 AND 10000),
  PRIMARY KEY (hub_id, purpose)
);
CREATE TABLE compliance.consents (
  hub_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES identity.users(id),
  purpose text NOT NULL,
  granted boolean NOT NULL,
  notice_version text NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (hub_id, user_id, purpose),
  FOREIGN KEY (hub_id, purpose) REFERENCES compliance.consent_purposes(hub_id, purpose)
);
CREATE TABLE compliance.consent_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  hub_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES identity.users(id),
  purpose text NOT NULL,
  granted boolean NOT NULL,
  notice_version text NOT NULL,
  notice_text text NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (hub_id, purpose) REFERENCES compliance.consent_purposes(hub_id, purpose)
);
-- Runtime can change only its own consent after joining the current hub.
-- Consent does not grant content access or silently create membership.
CREATE FUNCTION app.is_active_member() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM tenancy.memberships
    WHERE hub_id=app.hub_id() AND user_id=app.user_id() AND status='active')
$$;
ALTER TABLE compliance.consent_purposes ENABLE ROW LEVEL SECURITY;
ALTER TABLE compliance.consent_purposes FORCE ROW LEVEL SECURITY;
CREATE POLICY hub_scope ON compliance.consent_purposes
  USING (hub_id=app.hub_id()) WITH CHECK (hub_id=app.hub_id());
ALTER TABLE compliance.consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE compliance.consents FORCE ROW LEVEL SECURITY;
CREATE POLICY hub_scope ON compliance.consents
  USING (hub_id=app.hub_id()) WITH CHECK (hub_id=app.hub_id());
CREATE POLICY self_scope ON compliance.consents AS RESTRICTIVE
  USING (user_id=app.user_id()) WITH CHECK (user_id=app.user_id() AND (NOT granted OR app.is_active_member()));
ALTER TABLE compliance.consent_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE compliance.consent_events FORCE ROW LEVEL SECURITY;
CREATE POLICY hub_scope ON compliance.consent_events
  USING (hub_id=app.hub_id()) WITH CHECK (hub_id=app.hub_id());
CREATE POLICY self_scope ON compliance.consent_events AS RESTRICTIVE
  USING (user_id=app.user_id()) WITH CHECK (user_id=app.user_id());
CREATE FUNCTION app.audit_consent() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  INSERT INTO compliance.consent_events(hub_id,user_id,purpose,granted,notice_version,notice_text)
    SELECT NEW.hub_id,NEW.user_id,NEW.purpose,NEW.granted,NEW.notice_version,p.notice_text
    FROM compliance.consent_purposes p WHERE p.hub_id=NEW.hub_id AND p.purpose=NEW.purpose;
  RETURN NULL;
END $$;
CREATE FUNCTION app.validate_consent_notice() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  PERFORM 1 FROM compliance.consent_purposes
    WHERE hub_id=NEW.hub_id AND purpose=NEW.purpose AND notice_version=NEW.notice_version FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Consent notice changed' USING ERRCODE='23514'; END IF;
  NEW.changed_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER consent_notice BEFORE INSERT OR UPDATE ON compliance.consents
  FOR EACH ROW EXECUTE FUNCTION app.validate_consent_notice();
CREATE TRIGGER consent_audit AFTER INSERT OR UPDATE ON compliance.consents
  FOR EACH ROW EXECUTE FUNCTION app.audit_consent();
REVOKE ALL ON FUNCTION app.audit_consent() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.validate_consent_notice() FROM PUBLIC;
GRANT USAGE ON SCHEMA compliance TO plinth_app;
GRANT SELECT ON ALL TABLES IN SCHEMA compliance TO plinth_app;
GRANT INSERT,UPDATE ON compliance.consents TO plinth_app;
COMMIT;
