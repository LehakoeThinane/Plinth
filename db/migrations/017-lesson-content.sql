BEGIN;
CREATE SCHEMA content;
ALTER TABLE catalogue.lessons ADD CONSTRAINT lesson_boundary UNIQUE(hub_id,id,boundary_id);
-- Lesson text is delivered only after an access decision in the same snapshot.
-- It inherits the lesson's boundary, so company content stays inside it.
CREATE TABLE content.lesson_bodies (
  hub_id uuid NOT NULL,
  lesson_id uuid NOT NULL,
  boundary_id uuid NOT NULL,
  body text NOT NULL CHECK(length(body)<=50000),
  updated_by uuid REFERENCES identity.users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(hub_id,lesson_id),
  FOREIGN KEY(hub_id,lesson_id,boundary_id) REFERENCES catalogue.lessons(hub_id,id,boundary_id) ON UPDATE CASCADE
);
ALTER TABLE content.lesson_bodies ENABLE ROW LEVEL SECURITY;
ALTER TABLE content.lesson_bodies FORCE ROW LEVEL SECURITY;
CREATE POLICY hub_scope ON content.lesson_bodies USING(hub_id=app.hub_id()) WITH CHECK(hub_id=app.hub_id());
CREATE POLICY company_scope ON content.lesson_bodies AS RESTRICTIVE
  USING(app.can_read_boundary(boundary_id)) WITH CHECK(app.can_read_boundary(boundary_id));
CREATE POLICY admin_insert ON content.lesson_bodies AS RESTRICTIVE FOR INSERT WITH CHECK(app.is_hub_admin());
CREATE POLICY admin_update ON content.lesson_bodies AS RESTRICTIVE FOR UPDATE USING(app.is_hub_admin()) WITH CHECK(app.is_hub_admin());
CREATE FUNCTION app.stamp_lesson_body() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='UPDATE' AND (NEW.hub_id<>OLD.hub_id OR NEW.lesson_id<>OLD.lesson_id) THEN
    RAISE EXCEPTION 'Lesson body cannot move' USING ERRCODE='23514';
  END IF;
  NEW.updated_by:=app.user_id();NEW.updated_at:=now();
  RETURN NEW;
END $$;
CREATE TRIGGER lesson_body_stamp BEFORE INSERT OR UPDATE ON content.lesson_bodies
  FOR EACH ROW EXECUTE FUNCTION app.stamp_lesson_body();
REVOKE ALL ON FUNCTION app.stamp_lesson_body() FROM PUBLIC;
GRANT USAGE ON SCHEMA content TO plinth_app;
GRANT SELECT,INSERT ON content.lesson_bodies TO plinth_app;
GRANT UPDATE(body) ON content.lesson_bodies TO plinth_app;
COMMIT;
