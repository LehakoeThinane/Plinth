BEGIN;
CREATE TABLE compliance.notice_publications (
  hub_id uuid NOT NULL REFERENCES tenancy.hubs(id),
  purpose text NOT NULL,
  notice_version text NOT NULL,
  notice_text text,
  published_by uuid REFERENCES identity.users(id),
  published_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(hub_id,purpose,notice_version),
  FOREIGN KEY(hub_id,purpose) REFERENCES compliance.consent_purposes(hub_id,purpose)
);
-- Existing current notices are known; do not invent their author or date.
ALTER TABLE compliance.notice_publications ALTER COLUMN published_at DROP NOT NULL;
INSERT INTO compliance.notice_publications(hub_id,purpose,notice_version,notice_text,published_at)
  SELECT hub_id,purpose,notice_version,notice_text,NULL::timestamptz FROM compliance.consent_purposes;
-- Reserve every older version observed in consent history as well. A conflicting
-- historical text cannot be reconstructed as one publication; keep it unknown.
INSERT INTO compliance.notice_publications(hub_id,purpose,notice_version,notice_text,published_at)
  SELECT hub_id,purpose,notice_version,CASE WHEN count(DISTINCT notice_text)=1 THEN min(notice_text) ELSE NULL END,NULL::timestamptz
  FROM compliance.consent_events GROUP BY hub_id,purpose,notice_version
  ON CONFLICT(hub_id,purpose,notice_version) DO NOTHING;
INSERT INTO compliance.notice_publications(hub_id,purpose,notice_version,notice_text,published_at)
  SELECT DISTINCT hub_id,purpose,notice_version,NULL::text,NULL::timestamptz FROM compliance.consents
  ON CONFLICT(hub_id,purpose,notice_version) DO NOTHING;
ALTER TABLE compliance.notice_publications ENABLE ROW LEVEL SECURITY;
ALTER TABLE compliance.notice_publications FORCE ROW LEVEL SECURITY;
CREATE POLICY hub_scope ON compliance.notice_publications
  USING(hub_id=app.hub_id() OR current_user='plinth_consent_executor')
  WITH CHECK(hub_id=app.hub_id() OR current_user='plinth_consent_executor');
CREATE POLICY admin_scope ON compliance.notice_publications AS RESTRICTIVE
  USING(app.is_hub_admin() OR current_user='plinth_consent_executor')
  WITH CHECK(app.is_hub_admin() OR current_user='plinth_consent_executor');
CREATE POLICY admin_insert ON compliance.consent_purposes AS RESTRICTIVE FOR INSERT
  WITH CHECK(app.is_hub_admin());
CREATE POLICY admin_update ON compliance.consent_purposes AS RESTRICTIVE FOR UPDATE
  USING(app.is_hub_admin()) WITH CHECK(app.is_hub_admin());
GRANT INSERT ON compliance.consent_purposes TO plinth_app;
GRANT UPDATE(notice_version,notice_text) ON compliance.consent_purposes TO plinth_app;
GRANT SELECT ON compliance.notice_publications TO plinth_app;
GRANT USAGE ON SCHEMA app,compliance,tenancy TO plinth_consent_executor;
GRANT SELECT ON tenancy.memberships TO plinth_consent_executor;
GRANT SELECT,INSERT ON compliance.notice_publications TO plinth_consent_executor;

CREATE FUNCTION app.guard_notice_publication() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF length(btrim(NEW.notice_version))=0 OR length(btrim(NEW.notice_text))=0 THEN
    RAISE EXCEPTION 'Empty notice' USING ERRCODE='22023';
  END IF;
  IF TG_OP='UPDATE' AND (NEW.hub_id IS DISTINCT FROM OLD.hub_id OR NEW.purpose IS DISTINCT FROM OLD.purpose
    OR NEW.notice_version=OLD.notice_version) THEN
    RAISE EXCEPTION 'New notice version required' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE FUNCTION app.audit_notice_publication() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  INSERT INTO compliance.notice_publications(hub_id,purpose,notice_version,notice_text,published_by)
    VALUES(NEW.hub_id,NEW.purpose,NEW.notice_version,NEW.notice_text,app.user_id());
  RETURN NULL;
END;
$$;
CREATE TRIGGER notice_guard BEFORE INSERT OR UPDATE ON compliance.consent_purposes
  FOR EACH ROW EXECUTE FUNCTION app.guard_notice_publication();
CREATE TRIGGER notice_audit AFTER INSERT OR UPDATE ON compliance.consent_purposes
  FOR EACH ROW EXECUTE FUNCTION app.audit_notice_publication();
REVOKE ALL ON FUNCTION app.guard_notice_publication(),app.audit_notice_publication() FROM PUBLIC;
GRANT plinth_consent_executor TO CURRENT_USER;
GRANT CREATE ON SCHEMA app TO plinth_consent_executor;
ALTER FUNCTION app.audit_notice_publication() OWNER TO plinth_consent_executor;
REVOKE CREATE ON SCHEMA app FROM plinth_consent_executor;
REVOKE plinth_consent_executor FROM CURRENT_USER;
COMMIT;
