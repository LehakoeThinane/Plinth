BEGIN;
ALTER TABLE compliance.consent_purposes
  ADD COLUMN retired_at timestamptz,
  ADD COLUMN retired_by uuid REFERENCES identity.users(id);
CREATE TABLE compliance.notice_retirements (
  hub_id uuid NOT NULL REFERENCES tenancy.hubs(id),
  purpose text NOT NULL,
  notice_version text NOT NULL,
  retired_by uuid REFERENCES identity.users(id),
  retired_at timestamptz NOT NULL DEFAULT now(),
  -- A version can be retired once; republishing always needs a new version.
  PRIMARY KEY(hub_id,purpose,notice_version),
  FOREIGN KEY(hub_id,purpose) REFERENCES compliance.consent_purposes(hub_id,purpose)
);
ALTER TABLE compliance.notice_retirements ENABLE ROW LEVEL SECURITY;
ALTER TABLE compliance.notice_retirements FORCE ROW LEVEL SECURITY;
CREATE POLICY hub_scope ON compliance.notice_retirements
  USING(hub_id=app.hub_id() OR current_user='plinth_consent_executor')
  WITH CHECK(hub_id=app.hub_id() OR current_user='plinth_consent_executor');
CREATE POLICY admin_scope ON compliance.notice_retirements AS RESTRICTIVE
  USING(app.is_hub_admin() OR current_user='plinth_consent_executor')
  WITH CHECK(app.is_hub_admin() OR current_user='plinth_consent_executor');
GRANT SELECT ON compliance.notice_retirements TO plinth_app;
GRANT SELECT,INSERT ON compliance.notice_retirements TO plinth_consent_executor;
-- Runtime may request retirement; the guard stamps who and when.
GRANT UPDATE(retired_at) ON compliance.consent_purposes TO plinth_app;

CREATE OR REPLACE FUNCTION app.guard_notice_publication() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF length(btrim(NEW.notice_version))=0 OR length(btrim(NEW.notice_text))=0 THEN
    RAISE EXCEPTION 'Empty notice' USING ERRCODE='22023';
  END IF;
  IF TG_OP='INSERT' THEN
    NEW.retired_at:=NULL;NEW.retired_by:=NULL;
    RETURN NEW;
  END IF;
  IF NEW.hub_id IS DISTINCT FROM OLD.hub_id OR NEW.purpose IS DISTINCT FROM OLD.purpose THEN
    RAISE EXCEPTION 'New notice version required' USING ERRCODE='23514';
  END IF;
  IF NEW.notice_version=OLD.notice_version THEN
    -- The only same-version change is retiring an active notice, text unchanged.
    IF OLD.retired_at IS NOT NULL OR NEW.retired_at IS NULL OR NEW.notice_text IS DISTINCT FROM OLD.notice_text THEN
      RAISE EXCEPTION 'New notice version required' USING ERRCODE='23514';
    END IF;
    NEW.retired_at:=now();NEW.retired_by:=app.user_id();
  ELSE
    -- Publishing a new version reactivates the purpose; old grants stay inactive.
    NEW.retired_at:=NULL;NEW.retired_by:=NULL;
  END IF;
  RETURN NEW;
END;
$$;
CREATE OR REPLACE FUNCTION app.audit_notice_publication() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='UPDATE' AND NEW.notice_version=OLD.notice_version THEN
    INSERT INTO compliance.notice_retirements(hub_id,purpose,notice_version,retired_by,retired_at)
      VALUES(NEW.hub_id,NEW.purpose,NEW.notice_version,NEW.retired_by,NEW.retired_at);
  ELSE
    INSERT INTO compliance.notice_publications(hub_id,purpose,notice_version,notice_text,published_by)
      VALUES(NEW.hub_id,NEW.purpose,NEW.notice_version,NEW.notice_text,app.user_id());
  END IF;
  RETURN NULL;
END;
$$;
-- A retired purpose accepts withdrawals but never new grants.
CREATE OR REPLACE FUNCTION app.validate_consent_notice() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  PERFORM 1 FROM compliance.consent_purposes
    WHERE hub_id=NEW.hub_id AND purpose=NEW.purpose AND notice_version=NEW.notice_version
      AND (NOT NEW.granted OR retired_at IS NULL) FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Consent notice changed' USING ERRCODE='23514'; END IF;
  NEW.changed_at := now();
  RETURN NEW;
END $$;
COMMIT;
