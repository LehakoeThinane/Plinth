BEGIN;
ALTER TABLE identity.organisations
  ADD COLUMN type text CHECK(type IN ('company','provider')),
  ADD COLUMN legal_name text CHECK(length(legal_name) BETWEEN 1 AND 200),
  ADD COLUMN revision bigint NOT NULL DEFAULT 0;
CREATE TABLE identity.org_invitations (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES identity.organisations(id),
  target_user uuid NOT NULL REFERENCES identity.users(id),
  invited_by uuid NOT NULL REFERENCES identity.users(id),
  token_hash text NOT NULL UNIQUE CHECK(token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz NOT NULL DEFAULT now()+interval '7 days',
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX org_invitation_expiry ON identity.org_invitations(expires_at);
CREATE TABLE identity.org_events (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES identity.organisations(id),
  actor_user uuid NOT NULL REFERENCES identity.users(id),
  action text NOT NULL CHECK(action IN ('created','renamed','invited','invite_revoked','accepted','removed','role_changed')),
  target_user uuid REFERENCES identity.users(id),
  details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE identity.org_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.org_invitations FORCE ROW LEVEL SECURITY;
ALTER TABLE identity.org_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.org_events FORCE ROW LEVEL SECURITY;
CREATE POLICY executor_scope ON identity.org_invitations
  USING(current_user='plinth_identity_executor') WITH CHECK(current_user='plinth_identity_executor');
CREATE POLICY executor_scope ON identity.org_events
  USING(current_user='plinth_identity_executor') WITH CHECK(current_user='plinth_identity_executor');
-- Ordinary application reads remain restricted to the caller's memberships.
ALTER POLICY self_scope ON identity.org_members
  USING(user_id=app.user_id() OR current_user='plinth_identity_executor')
  WITH CHECK(user_id=app.user_id() OR current_user='plinth_identity_executor');
ALTER POLICY member_scope ON identity.organisations
  USING(app.is_org_member(id) OR current_user='plinth_identity_executor')
  WITH CHECK(app.is_org_member(id,true) OR current_user='plinth_identity_executor');
GRANT USAGE ON SCHEMA app,identity TO plinth_identity_executor;
GRANT SELECT ON identity.users TO plinth_identity_executor;
GRANT SELECT,INSERT,UPDATE ON identity.organisations,identity.org_members,identity.org_invitations TO plinth_identity_executor;
GRANT SELECT,INSERT ON identity.org_events TO plinth_identity_executor;

CREATE FUNCTION app.create_organisation(p_id uuid,p_name text,p_type text,p_legal text,p_event uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM identity.users WHERE id=app.user_id()) THEN
    RAISE EXCEPTION 'Not found' USING ERRCODE='42501';
  END IF;
  IF p_name IS NULL OR length(btrim(p_name)) NOT BETWEEN 1 AND 200 OR
    p_type IS NULL OR p_type NOT IN ('company','provider') OR
    p_legal IS NULL OR length(btrim(p_legal)) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'Invalid organisation' USING ERRCODE='22023';
  END IF;
  INSERT INTO identity.organisations(id,display_name,type,legal_name) VALUES(p_id,btrim(p_name),p_type,btrim(p_legal));
  INSERT INTO identity.org_members(user_id,org_id,status,role) VALUES(app.user_id(),p_id,'active','admin');
  INSERT INTO identity.org_events(id,org_id,actor_user,action) VALUES(p_event,p_id,app.user_id(),'created');
END;
$$;

CREATE FUNCTION app.organisation_admin_view(p_org uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE result jsonb;
BEGIN
  IF NOT app.is_org_member(p_org,true) THEN RAISE EXCEPTION 'Not found' USING ERRCODE='42501'; END IF;
  SELECT jsonb_build_object('organisation',jsonb_build_object('id',o.id,'displayName',o.display_name,'type',o.type,'legalName',o.legal_name),
    'members',COALESCE((SELECT jsonb_agg(jsonb_build_object('userId',m.user_id,'role',m.role,'status',m.status) ORDER BY m.user_id)
      FROM identity.org_members m WHERE m.org_id=p_org),'[]'::jsonb),
    'invitations',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',i.id,'userId',i.target_user,'expiresAt',i.expires_at,
      'accepted',i.accepted_at IS NOT NULL,'revoked',i.revoked_at IS NOT NULL) ORDER BY i.created_at)
      FROM identity.org_invitations i WHERE i.org_id=p_org),'[]'::jsonb),
    'events',COALESCE((SELECT jsonb_agg(e.data ORDER BY e.created_at DESC,e.id) FROM
      (SELECT id,created_at,jsonb_build_object('id',id,'actorUser',actor_user,'action',action,'targetUser',target_user,
        'details',details,'createdAt',created_at) AS data FROM identity.org_events WHERE org_id=p_org
        ORDER BY created_at DESC,id LIMIT 100) e),'[]'::jsonb)) INTO result
  FROM identity.organisations o WHERE o.id=p_org;
  RETURN result;
END;
$$;

CREATE FUNCTION app.manage_organisation(p_org uuid,p_action text,p_input jsonb,p_event uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE target uuid; member_role text; member_status text; invite identity.org_invitations%ROWTYPE; detail jsonb:='{}';
BEGIN
  IF p_action IS NULL OR p_action NOT IN ('renamed','invited','invite_revoked','removed','role_changed','accepted') THEN
    RAISE EXCEPTION 'Invalid action' USING ERRCODE='22023';
  END IF;
  -- Updating this shared row serialises all membership/authority changes.
  -- REPEATABLE READ writers with a stale snapshot fail with 40001 and retry.
  UPDATE identity.organisations SET revision=revision+1 WHERE id=p_org;
  IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE='42501'; END IF;
  IF p_action<>'accepted' AND NOT app.is_org_member(p_org,true) THEN
    RAISE EXCEPTION 'Not found' USING ERRCODE='42501';
  END IF;
  CASE p_action
  WHEN 'renamed' THEN
    IF length(btrim(p_input->>'displayName')) NOT BETWEEN 1 AND 200 OR p_input->>'displayName' IS NULL OR
      length(btrim(p_input->>'legalName')) NOT BETWEEN 1 AND 200 OR p_input->>'legalName' IS NULL THEN
      RAISE EXCEPTION 'Invalid name' USING ERRCODE='22023';
    END IF;
    UPDATE identity.organisations SET display_name=btrim(p_input->>'displayName'),legal_name=btrim(p_input->>'legalName') WHERE id=p_org;
  WHEN 'invited' THEN
    target:=(p_input->>'userId')::uuid;
    IF EXISTS(SELECT 1 FROM identity.org_members WHERE org_id=p_org AND user_id=target AND status='active') THEN
      RAISE EXCEPTION 'Already a member' USING ERRCODE='23505';
    END IF;
    INSERT INTO identity.org_invitations(id,org_id,target_user,invited_by,token_hash)
      VALUES((p_input->>'id')::uuid,p_org,target,app.user_id(),p_input->>'tokenHash');
  WHEN 'invite_revoked' THEN
    UPDATE identity.org_invitations SET revoked_at=now() WHERE org_id=p_org AND id=(p_input->>'id')::uuid
      AND accepted_at IS NULL AND revoked_at IS NULL RETURNING target_user INTO target;
    IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE='42501'; END IF;
  WHEN 'removed','role_changed' THEN
    target:=(p_input->>'userId')::uuid;
    SELECT role,status INTO member_role,member_status FROM identity.org_members WHERE org_id=p_org AND user_id=target;
    IF NOT FOUND OR member_status<>'active' THEN RAISE EXCEPTION 'Not found' USING ERRCODE='42501'; END IF;
    IF p_action='role_changed' AND (p_input->>'role' IS NULL OR p_input->>'role' NOT IN ('admin','member')) THEN
      RAISE EXCEPTION 'Invalid role' USING ERRCODE='22023';
    END IF;
    IF member_role='admin' AND (p_action='removed' OR p_input->>'role'='member') AND
      (SELECT count(*) FROM identity.org_members WHERE org_id=p_org AND status='active' AND role='admin')<=1 THEN
      RAISE EXCEPTION 'Last administrator' USING ERRCODE='23514';
    END IF;
    IF p_action='removed' THEN
      UPDATE identity.org_members SET status='ended' WHERE org_id=p_org AND user_id=target;
      UPDATE identity.org_invitations SET revoked_at=now() WHERE org_id=p_org AND accepted_at IS NULL AND revoked_at IS NULL
        AND (target_user=target OR invited_by=target);
    ELSE
      UPDATE identity.org_members SET role=p_input->>'role' WHERE org_id=p_org AND user_id=target;
      detail:=jsonb_build_object('role',p_input->>'role');
      IF p_input->>'role'='member' THEN
        UPDATE identity.org_invitations SET revoked_at=now() WHERE org_id=p_org AND invited_by=target AND accepted_at IS NULL AND revoked_at IS NULL;
      END IF;
    END IF;
  WHEN 'accepted' THEN
    SELECT * INTO invite FROM identity.org_invitations WHERE org_id=p_org AND token_hash=p_input->>'tokenHash'
      AND target_user=app.user_id() AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>now();
    IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM identity.org_members WHERE org_id=p_org AND user_id=invite.invited_by AND status='active' AND role='admin') THEN
      RAISE EXCEPTION 'Not found' USING ERRCODE='42501';
    END IF;
    target:=app.user_id();
    -- An old invitation can never demote an existing admin.
    INSERT INTO identity.org_members(user_id,org_id,status,role) VALUES(target,p_org,'active','member')
      ON CONFLICT(user_id,org_id) DO UPDATE SET status='active',role='member' WHERE identity.org_members.status='ended';
    UPDATE identity.org_invitations SET accepted_at=now() WHERE id=invite.id;
  END CASE;
  INSERT INTO identity.org_events(id,org_id,actor_user,action,target_user,details)
    VALUES(p_event,p_org,app.user_id(),p_action,target,detail);
END;
$$;
REVOKE ALL ON FUNCTION app.create_organisation(uuid,text,text,text,uuid),app.organisation_admin_view(uuid),
  app.manage_organisation(uuid,text,jsonb,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.create_organisation(uuid,text,text,text,uuid),app.organisation_admin_view(uuid),
  app.manage_organisation(uuid,text,jsonb,uuid) TO plinth_app;
GRANT plinth_identity_executor TO CURRENT_USER;
GRANT CREATE ON SCHEMA app TO plinth_identity_executor;
ALTER FUNCTION app.create_organisation(uuid,text,text,text,uuid) OWNER TO plinth_identity_executor;
ALTER FUNCTION app.organisation_admin_view(uuid) OWNER TO plinth_identity_executor;
ALTER FUNCTION app.manage_organisation(uuid,text,jsonb,uuid) OWNER TO plinth_identity_executor;
REVOKE CREATE ON SCHEMA app FROM plinth_identity_executor;
REVOKE plinth_identity_executor FROM CURRENT_USER;
COMMIT;
