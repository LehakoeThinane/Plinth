BEGIN;
-- This non-login role owns only auth functions, never tenant tables. It has no
-- superuser/BYPASSRLS attribute; narrowly scoped policies permit its operations.
GRANT USAGE ON SCHEMA app,identity TO plinth_auth_executor;
GRANT SELECT,INSERT ON identity.users,identity.auth_links TO plinth_auth_executor;
GRANT SELECT ON identity.auth_issuers TO plinth_auth_executor;
GRANT SELECT,INSERT,DELETE ON identity.auth_sessions TO plinth_auth_executor;
ALTER POLICY self_scope ON identity.users
  USING(id=app.user_id() OR current_user='plinth_auth_executor')
  WITH CHECK(id=app.user_id() OR current_user='plinth_auth_executor');
ALTER POLICY self_scope ON identity.auth_links
  USING(user_id=app.user_id() OR current_user='plinth_auth_executor')
  WITH CHECK(user_id=app.user_id() OR current_user='plinth_auth_executor');
CREATE POLICY executor_scope ON identity.auth_issuers FOR SELECT TO plinth_auth_executor
  USING(current_user='plinth_auth_executor');
ALTER POLICY hub_scope ON identity.auth_sessions
  USING(hub_id=app.hub_id() OR current_user='plinth_auth_executor')
  WITH CHECK(hub_id=app.hub_id() OR current_user='plinth_auth_executor');
ALTER POLICY self_scope ON identity.auth_sessions
  USING(user_id=app.user_id() OR current_user='plinth_auth_executor')
  WITH CHECK(user_id=app.user_id() OR current_user='plinth_auth_executor');
-- Temporarily give the migration caller ownership-transfer capability.
GRANT plinth_auth_executor TO CURRENT_USER;
GRANT CREATE ON SCHEMA app TO plinth_auth_executor;
ALTER FUNCTION app.resolve_auth_user(text,text,uuid) OWNER TO plinth_auth_executor;
ALTER FUNCTION app.store_auth_session(text,uuid,uuid,text,text,timestamptz) OWNER TO plinth_auth_executor;
ALTER FUNCTION app.read_auth_session(text) OWNER TO plinth_auth_executor;
ALTER FUNCTION app.end_auth_session(text) OWNER TO plinth_auth_executor;
ALTER FUNCTION app.prune_auth_sessions() OWNER TO plinth_auth_executor;
REVOKE CREATE ON SCHEMA app FROM plinth_auth_executor;
REVOKE plinth_auth_executor FROM CURRENT_USER;
COMMIT;
