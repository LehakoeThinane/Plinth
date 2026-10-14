BEGIN;
CREATE SCHEMA community;
-- Spaces carry a boundary like products: company spaces set its organisation,
-- so row-level security hides them and everything in them from outsiders.
CREATE TABLE community.spaces (
  hub_id uuid NOT NULL REFERENCES tenancy.hubs(id),
  id uuid NOT NULL,
  boundary_id uuid NOT NULL,
  title text NOT NULL CHECK(length(btrim(title)) BETWEEN 1 AND 120),
  description text NOT NULL DEFAULT '' CHECK(length(description)<=2000),
  visibility text NOT NULL CHECK(visibility IN ('hub','tier','company')),
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(hub_id,id),
  UNIQUE(hub_id,id,boundary_id),
  FOREIGN KEY(hub_id,boundary_id) REFERENCES tenancy.boundaries(hub_id,id)
);
CREATE TABLE community.posts (
  hub_id uuid NOT NULL,
  id uuid NOT NULL,
  space_id uuid NOT NULL,
  boundary_id uuid NOT NULL,
  author_id uuid NOT NULL REFERENCES identity.users(id),
  body text NOT NULL CHECK(length(btrim(body)) BETWEEN 1 AND 10000),
  status text NOT NULL DEFAULT 'visible' CHECK(status IN ('visible','hidden','removed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(hub_id,id),
  UNIQUE(hub_id,id,space_id,boundary_id),
  FOREIGN KEY(hub_id,space_id,boundary_id) REFERENCES community.spaces(hub_id,id,boundary_id)
);
CREATE INDEX posts_feed ON community.posts(hub_id,space_id,created_at DESC,id DESC);
CREATE TABLE community.comments (
  hub_id uuid NOT NULL,
  id uuid NOT NULL,
  post_id uuid NOT NULL,
  space_id uuid NOT NULL,
  boundary_id uuid NOT NULL,
  author_id uuid NOT NULL REFERENCES identity.users(id),
  body text NOT NULL CHECK(length(btrim(body)) BETWEEN 1 AND 5000),
  status text NOT NULL DEFAULT 'visible' CHECK(status IN ('visible','hidden','removed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(hub_id,id),
  FOREIGN KEY(hub_id,post_id,space_id,boundary_id) REFERENCES community.posts(hub_id,id,space_id,boundary_id)
);
CREATE INDEX comments_thread ON community.comments(hub_id,post_id,created_at,id);
CREATE TABLE community.reactions (
  hub_id uuid NOT NULL,
  post_id uuid NOT NULL,
  space_id uuid NOT NULL,
  boundary_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES identity.users(id),
  kind text NOT NULL CHECK(kind IN ('like','insightful','thanks')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(hub_id,post_id,user_id,kind),
  FOREIGN KEY(hub_id,post_id,space_id,boundary_id) REFERENCES community.posts(hub_id,id,space_id,boundary_id)
);
CREATE TABLE community.reports (
  hub_id uuid NOT NULL,
  id uuid NOT NULL,
  space_id uuid NOT NULL,
  boundary_id uuid NOT NULL,
  target_type text NOT NULL CHECK(target_type IN ('post','comment')),
  target_id uuid NOT NULL,
  reporter_id uuid NOT NULL REFERENCES identity.users(id),
  reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 1000),
  status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','dismissed','actioned')),
  resolution text CHECK(resolution IN ('dismiss','hide','remove','suspend')),
  resolved_by uuid REFERENCES identity.users(id),
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(hub_id,id),
  FOREIGN KEY(hub_id,space_id,boundary_id) REFERENCES community.spaces(hub_id,id,boundary_id),
  CHECK((status='open')=(resolution IS NULL))
);
-- One open report per person and target: repeated flags do not pile up.
CREATE UNIQUE INDEX reports_open_once ON community.reports(hub_id,target_type,target_id,reporter_id) WHERE status='open';

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['spaces','posts','comments','reactions','reports'] LOOP
    EXECUTE format('ALTER TABLE community.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE community.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY hub_scope ON community.%I USING(hub_id=app.hub_id()) WITH CHECK(hub_id=app.hub_id())',t);
    EXECUTE format('CREATE POLICY company_scope ON community.%I AS RESTRICTIVE USING(app.can_read_boundary(boundary_id)) WITH CHECK(app.can_read_boundary(boundary_id))',t);
  END LOOP;
END $$;
-- Spaces are created by owners/admins. Contributions are written by active
-- members as themselves; the space access decision runs in the same transaction.
CREATE POLICY admin_insert ON community.spaces AS RESTRICTIVE FOR INSERT WITH CHECK(app.is_hub_admin());
CREATE POLICY admin_update ON community.spaces AS RESTRICTIVE FOR UPDATE USING(app.is_hub_admin()) WITH CHECK(app.is_hub_admin());
CREATE POLICY author_insert ON community.posts AS RESTRICTIVE FOR INSERT WITH CHECK(author_id=app.user_id() AND app.is_active_member());
CREATE POLICY author_update ON community.posts AS RESTRICTIVE FOR UPDATE TO plinth_app USING(author_id=app.user_id()) WITH CHECK(author_id=app.user_id());
CREATE POLICY author_insert ON community.comments AS RESTRICTIVE FOR INSERT WITH CHECK(author_id=app.user_id() AND app.is_active_member());
CREATE POLICY author_update ON community.comments AS RESTRICTIVE FOR UPDATE TO plinth_app USING(author_id=app.user_id()) WITH CHECK(author_id=app.user_id());
CREATE POLICY self_scope ON community.reactions AS RESTRICTIVE FOR INSERT WITH CHECK(user_id=app.user_id() AND app.is_active_member());
CREATE POLICY self_delete ON community.reactions AS RESTRICTIVE FOR DELETE USING(user_id=app.user_id());
CREATE POLICY reporter_insert ON community.reports AS RESTRICTIVE FOR INSERT WITH CHECK(reporter_id=app.user_id() AND app.is_active_member());
-- Reports are read by moderators and by the person who filed them.
CREATE POLICY report_read ON community.reports AS RESTRICTIVE FOR SELECT USING(app.is_hub_admin() OR reporter_id=app.user_id());

-- Authors may only withdraw their own contribution (visible -> removed).
CREATE FUNCTION app.guard_contribution() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF NEW.body<>OLD.body OR NEW.author_id<>OLD.author_id OR NEW.created_at<>OLD.created_at
    OR NOT (OLD.status='visible' AND NEW.status='removed') THEN
    RAISE EXCEPTION 'Authors can only remove their own visible contribution' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER post_guard BEFORE UPDATE ON community.posts FOR EACH ROW
  WHEN (current_user<>'plinth_community_moderator') EXECUTE FUNCTION app.guard_contribution();
CREATE TRIGGER comment_guard BEFORE UPDATE ON community.comments FOR EACH ROW
  WHEN (current_user<>'plinth_community_moderator') EXECUTE FUNCTION app.guard_contribution();
REVOKE ALL ON FUNCTION app.guard_contribution() FROM PUBLIC;

GRANT USAGE ON SCHEMA community TO plinth_app;
GRANT SELECT,INSERT ON ALL TABLES IN SCHEMA community TO plinth_app;
GRANT UPDATE(title,description,status) ON community.spaces TO plinth_app;
GRANT UPDATE(status) ON community.posts,community.comments TO plinth_app;
GRANT DELETE ON community.reactions TO plinth_app;

-- Moderation runs as a constrained non-login executor so a report resolution,
-- the content change and any suspension commit together.
GRANT USAGE ON SCHEMA app,community,tenancy TO plinth_community_moderator;
GRANT SELECT ON tenancy.memberships,tenancy.boundaries TO plinth_community_moderator;
GRANT UPDATE(status) ON tenancy.memberships TO plinth_community_moderator;
GRANT SELECT,UPDATE ON community.posts,community.comments,community.reports TO plinth_community_moderator;
-- The moderator may read the hub's memberships and only ever suspend an ordinary member.
ALTER POLICY self_scope ON tenancy.memberships
  USING(user_id=app.user_id() OR current_user='plinth_community_moderator')
  WITH CHECK(user_id=app.user_id() OR current_user='plinth_community_moderator');
CREATE POLICY moderator_suspend ON tenancy.memberships AS RESTRICTIVE FOR UPDATE TO plinth_community_moderator
  USING(role='member') WITH CHECK(role='member' AND status='suspended');
CREATE FUNCTION app.resolve_report(p_report uuid,p_action text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE report community.reports%ROWTYPE; author uuid;
BEGIN
  IF NOT app.is_hub_admin() THEN RAISE EXCEPTION 'Not found' USING ERRCODE='42501'; END IF;
  IF p_action IS NULL OR p_action NOT IN ('dismiss','hide','remove','suspend') THEN
    RAISE EXCEPTION 'Invalid action' USING ERRCODE='22023';
  END IF;
  SELECT * INTO report FROM community.reports WHERE hub_id=app.hub_id() AND id=p_report AND status='open' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Report not open' USING ERRCODE='23514'; END IF;
  IF p_action<>'dismiss' THEN
    IF report.target_type='post' THEN
      UPDATE community.posts SET status=CASE WHEN p_action='hide' THEN 'hidden' ELSE 'removed' END
        WHERE hub_id=report.hub_id AND id=report.target_id RETURNING author_id INTO author;
    ELSE
      UPDATE community.comments SET status=CASE WHEN p_action='hide' THEN 'hidden' ELSE 'removed' END
        WHERE hub_id=report.hub_id AND id=report.target_id RETURNING author_id INTO author;
    END IF;
    IF p_action='suspend' THEN
      -- Only ordinary members can be suspended here, never staff or the moderator.
      IF author=app.user_id() THEN RAISE EXCEPTION 'Cannot suspend yourself' USING ERRCODE='23514'; END IF;
      UPDATE tenancy.memberships SET status='suspended' WHERE hub_id=report.hub_id AND user_id=author AND role='member';
      IF NOT FOUND THEN RAISE EXCEPTION 'Only members can be suspended' USING ERRCODE='23514'; END IF;
    END IF;
  END IF;
  -- Resolving one report closes every open report on the same target.
  UPDATE community.reports SET status=CASE WHEN p_action='dismiss' THEN 'dismissed' ELSE 'actioned' END,
    resolution=p_action,resolved_by=app.user_id(),resolved_at=now()
    WHERE hub_id=report.hub_id AND target_type=report.target_type AND target_id=report.target_id AND status='open';
  RETURN p_action;
END $$;
REVOKE ALL ON FUNCTION app.resolve_report(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resolve_report(uuid,text) TO plinth_app;
GRANT plinth_community_moderator TO CURRENT_USER;
GRANT CREATE ON SCHEMA app TO plinth_community_moderator;
ALTER FUNCTION app.resolve_report(uuid,text) OWNER TO plinth_community_moderator;
REVOKE CREATE ON SCHEMA app FROM plinth_community_moderator;
REVOKE plinth_community_moderator FROM CURRENT_USER;
COMMIT;
