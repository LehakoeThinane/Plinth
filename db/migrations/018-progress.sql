BEGIN;
-- One row per learner and lesson. Completion and furthest position only move
-- forward; resume position can move back. Writes happen after an access
-- decision in the same transaction.
CREATE TABLE content.lesson_progress (
  hub_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES identity.users(id),
  lesson_id uuid NOT NULL,
  boundary_id uuid NOT NULL,
  revision bigint NOT NULL CHECK(revision>0),
  furthest_position double precision NOT NULL CHECK(furthest_position BETWEEN 0 AND 10000000),
  resume_position double precision NOT NULL CHECK(resume_position BETWEEN 0 AND 10000000),
  completed boolean NOT NULL,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(hub_id,user_id,lesson_id),
  FOREIGN KEY(hub_id,lesson_id,boundary_id) REFERENCES catalogue.lessons(hub_id,id,boundary_id) ON UPDATE CASCADE,
  CHECK(completed=(completed_at IS NOT NULL))
);
-- Idempotency: a retried request with the same key and payload gets the stored
-- result; the same key with a different payload is rejected.
CREATE TABLE content.progress_requests (
  hub_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES identity.users(id),
  idempotency_key text NOT NULL CHECK(idempotency_key ~ '^[A-Za-z0-9_-]{8,100}$'),
  request_hash text NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'),
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(hub_id,user_id,idempotency_key)
);
CREATE INDEX progress_requests_age ON content.progress_requests(created_at);
ALTER TABLE content.lesson_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE content.lesson_progress FORCE ROW LEVEL SECURITY;
CREATE POLICY hub_scope ON content.lesson_progress USING(hub_id=app.hub_id()) WITH CHECK(hub_id=app.hub_id());
CREATE POLICY company_scope ON content.lesson_progress AS RESTRICTIVE
  USING(app.can_read_boundary(boundary_id)) WITH CHECK(app.can_read_boundary(boundary_id));
CREATE POLICY self_scope ON content.lesson_progress AS RESTRICTIVE
  USING(user_id=app.user_id()) WITH CHECK(user_id=app.user_id());
ALTER TABLE content.progress_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE content.progress_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY hub_scope ON content.progress_requests USING(hub_id=app.hub_id()) WITH CHECK(hub_id=app.hub_id());
CREATE POLICY self_scope ON content.progress_requests AS RESTRICTIVE
  USING(user_id=app.user_id()) WITH CHECK(user_id=app.user_id());
CREATE FUNCTION app.guard_progress() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW.hub_id<>OLD.hub_id OR NEW.user_id<>OLD.user_id OR NEW.lesson_id<>OLD.lesson_id
      OR NEW.revision<>OLD.revision+1 OR NEW.furthest_position<OLD.furthest_position OR (OLD.completed AND NOT NEW.completed) THEN
      RAISE EXCEPTION 'Progress can only move forward one revision at a time' USING ERRCODE='23514';
    END IF;
    IF OLD.completed THEN NEW.completed_at:=OLD.completed_at; END IF;
  ELSIF NEW.revision<>1 THEN
    RAISE EXCEPTION 'Progress starts at revision 1' USING ERRCODE='23514';
  END IF;
  IF NEW.completed AND NEW.completed_at IS NULL THEN NEW.completed_at:=now(); END IF;
  NEW.updated_at:=now();
  RETURN NEW;
END $$;
CREATE TRIGGER progress_guard BEFORE INSERT OR UPDATE ON content.lesson_progress
  FOR EACH ROW EXECUTE FUNCTION app.guard_progress();
REVOKE ALL ON FUNCTION app.guard_progress() FROM PUBLIC;
GRANT SELECT,INSERT ON content.lesson_progress,content.progress_requests TO plinth_app;
GRANT UPDATE(revision,furthest_position,resume_position,completed,completed_at) ON content.lesson_progress TO plinth_app;
COMMIT;
