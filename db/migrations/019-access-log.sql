BEGIN;
-- Append-only record of who opened which lesson content, when and on what
-- device, for leak investigation (Deep dive 2). Learners can only add their
-- own entries; hub owners/admins read them; runtime cannot change or delete.
CREATE TABLE content.lesson_opens (
  hub_id uuid NOT NULL,
  id bigint GENERATED ALWAYS AS IDENTITY,
  user_id uuid NOT NULL REFERENCES identity.users(id),
  lesson_id uuid NOT NULL,
  boundary_id uuid NOT NULL,
  user_agent text CHECK(length(user_agent)<=300),
  opened_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(hub_id,id),
  FOREIGN KEY(hub_id,lesson_id,boundary_id) REFERENCES catalogue.lessons(hub_id,id,boundary_id) ON UPDATE CASCADE
);
CREATE INDEX lesson_opens_age ON content.lesson_opens(opened_at);
CREATE INDEX lesson_opens_lesson ON content.lesson_opens(hub_id,lesson_id,opened_at);
ALTER TABLE content.lesson_opens ENABLE ROW LEVEL SECURITY;
ALTER TABLE content.lesson_opens FORCE ROW LEVEL SECURITY;
CREATE POLICY hub_scope ON content.lesson_opens
  USING(hub_id=app.hub_id() OR current_user='plinth_retention_executor')
  WITH CHECK(hub_id=app.hub_id());
CREATE POLICY company_scope ON content.lesson_opens AS RESTRICTIVE
  USING(app.can_read_boundary(boundary_id) OR current_user='plinth_retention_executor')
  WITH CHECK(app.can_read_boundary(boundary_id));
CREATE POLICY admin_read ON content.lesson_opens AS RESTRICTIVE FOR SELECT
  USING(app.is_hub_admin() OR current_user='plinth_retention_executor');
CREATE POLICY self_insert ON content.lesson_opens AS RESTRICTIVE FOR INSERT
  WITH CHECK(user_id=app.user_id());
GRANT INSERT,SELECT ON content.lesson_opens TO plinth_app;

-- Retention is executed only by a separate maintenance login through these
-- functions, so application credentials cannot erase the trail.
ALTER POLICY hub_scope ON content.progress_requests
  USING(hub_id=app.hub_id() OR current_user='plinth_retention_executor') WITH CHECK(hub_id=app.hub_id());
ALTER POLICY self_scope ON content.progress_requests
  USING(user_id=app.user_id() OR current_user='plinth_retention_executor') WITH CHECK(user_id=app.user_id());
GRANT USAGE ON SCHEMA app,content,tenancy TO plinth_retention_executor;
-- Policy functions read these; without a hub context RLS shows the executor no rows.
GRANT SELECT ON tenancy.boundaries,tenancy.memberships TO plinth_retention_executor;
GRANT SELECT,DELETE ON content.lesson_opens,content.progress_requests TO plinth_retention_executor;

-- The retention period is a deployment decision (see docs/retention.md); no
-- default is assumed. Without p_apply the functions only count.
CREATE FUNCTION app.expire_lesson_opens(p_days integer,p_apply boolean) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE affected bigint;
BEGIN
  IF p_days IS NULL OR p_days NOT BETWEEN 1 AND 3650 THEN RAISE EXCEPTION 'Invalid retention' USING ERRCODE='22023'; END IF;
  IF p_apply THEN
    DELETE FROM content.lesson_opens WHERE opened_at<now()-make_interval(days=>p_days);
    GET DIAGNOSTICS affected=ROW_COUNT;
  ELSE
    SELECT count(*) INTO affected FROM content.lesson_opens WHERE opened_at<now()-make_interval(days=>p_days);
  END IF;
  RETURN affected;
END $$;
CREATE FUNCTION app.expire_progress_requests(p_hours integer,p_apply boolean) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE affected bigint;
BEGIN
  -- Keys must outlive any client retry window; a day is the floor.
  IF p_hours IS NULL OR p_hours NOT BETWEEN 24 AND 8760 THEN RAISE EXCEPTION 'Invalid retention' USING ERRCODE='22023'; END IF;
  IF p_apply THEN
    DELETE FROM content.progress_requests WHERE created_at<now()-make_interval(hours=>p_hours);
    GET DIAGNOSTICS affected=ROW_COUNT;
  ELSE
    SELECT count(*) INTO affected FROM content.progress_requests WHERE created_at<now()-make_interval(hours=>p_hours);
  END IF;
  RETURN affected;
END $$;
REVOKE ALL ON FUNCTION app.expire_lesson_opens(integer,boolean),app.expire_progress_requests(integer,boolean) FROM PUBLIC;
GRANT USAGE ON SCHEMA app TO plinth_maintenance;
GRANT EXECUTE ON FUNCTION app.expire_lesson_opens(integer,boolean),app.expire_progress_requests(integer,boolean) TO plinth_maintenance;
GRANT plinth_retention_executor TO CURRENT_USER;
GRANT CREATE ON SCHEMA app TO plinth_retention_executor;
ALTER FUNCTION app.expire_lesson_opens(integer,boolean) OWNER TO plinth_retention_executor;
ALTER FUNCTION app.expire_progress_requests(integer,boolean) OWNER TO plinth_retention_executor;
REVOKE CREATE ON SCHEMA app FROM plinth_retention_executor;
REVOKE plinth_retention_executor FROM CURRENT_USER;
COMMIT;
