BEGIN;
CREATE SCHEMA messaging;
-- Conversations are shared by enquiries now and direct/group messaging later.
CREATE TABLE messaging.conversations (
  hub_id uuid NOT NULL REFERENCES tenancy.hubs(id),
  id uuid NOT NULL,
  type text NOT NULL CHECK(type IN ('enquiry')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(hub_id,id)
);
CREATE TABLE messaging.participants (
  hub_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES identity.users(id),
  role text NOT NULL CHECK(role IN ('requester','provider')),
  last_read_at timestamptz,
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(hub_id,conversation_id,user_id),
  FOREIGN KEY(hub_id,conversation_id) REFERENCES messaging.conversations(hub_id,id)
);
CREATE TABLE messaging.messages (
  hub_id uuid NOT NULL,
  id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  sender_id uuid NOT NULL REFERENCES identity.users(id),
  -- The client's own id makes a retried send idempotent.
  client_id uuid NOT NULL,
  body text NOT NULL CHECK(length(btrim(body)) BETWEEN 1 AND 5000),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(hub_id,id),
  UNIQUE(hub_id,conversation_id,sender_id,client_id),
  FOREIGN KEY(hub_id,conversation_id) REFERENCES messaging.conversations(hub_id,id)
);
CREATE INDEX messages_history ON messaging.messages(hub_id,conversation_id,created_at,id);
CREATE TABLE messaging.enquiries (
  hub_id uuid NOT NULL,
  id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  requester_id uuid NOT NULL REFERENCES identity.users(id),
  requester_org uuid REFERENCES identity.organisations(id),
  subject text NOT NULL CHECK(length(btrim(subject)) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','in_discussion','closed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(hub_id,id),
  UNIQUE(hub_id,conversation_id),
  FOREIGN KEY(hub_id,conversation_id) REFERENCES messaging.conversations(hub_id,id)
);
CREATE INDEX enquiries_inbox ON messaging.enquiries(hub_id,status,updated_at DESC);

-- Definer helpers read participants without recursive policies. Hub owners and
-- admins may read enquiry conversations, never other conversation types.
CREATE FUNCTION app.can_read_conversation(p_conversation uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT EXISTS(SELECT 1 FROM messaging.participants WHERE hub_id=app.hub_id() AND conversation_id=p_conversation AND user_id=app.user_id())
    OR (app.is_hub_admin() AND EXISTS(SELECT 1 FROM messaging.conversations WHERE hub_id=app.hub_id() AND id=p_conversation AND type='enquiry'))
$$;
-- A suspended member cannot write anywhere in the hub; non-members (prospects
-- enquiring) can.
CREATE FUNCTION app.not_suspended() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT NOT EXISTS(SELECT 1 FROM tenancy.memberships WHERE hub_id=app.hub_id() AND user_id=app.user_id() AND status='suspended')
$$;
CREATE FUNCTION app.can_write_conversation(p_conversation uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT app.can_read_conversation(p_conversation) AND app.not_suspended()
    AND NOT EXISTS(SELECT 1 FROM messaging.enquiries WHERE hub_id=app.hub_id() AND conversation_id=p_conversation AND status='closed')
$$;
-- An enquiry may only claim a brand-new enquiry conversation that nobody has joined,
-- so no one can attach themselves to an existing conversation.
CREATE FUNCTION app.is_unclaimed_enquiry(p_conversation uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT EXISTS(SELECT 1 FROM messaging.conversations WHERE hub_id=app.hub_id() AND id=p_conversation AND type='enquiry')
    AND NOT EXISTS(SELECT 1 FROM messaging.participants WHERE hub_id=app.hub_id() AND conversation_id=p_conversation)
    AND NOT EXISTS(SELECT 1 FROM messaging.enquiries WHERE hub_id=app.hub_id() AND conversation_id=p_conversation)
$$;
-- The requester may join only the conversation of their own enquiry.
CREATE FUNCTION app.is_enquiry_requester(p_conversation uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT EXISTS(SELECT 1 FROM messaging.enquiries WHERE hub_id=app.hub_id() AND conversation_id=p_conversation AND requester_id=app.user_id())
$$;
REVOKE ALL ON FUNCTION app.can_read_conversation(uuid),app.not_suspended(),app.can_write_conversation(uuid),app.is_unclaimed_enquiry(uuid),app.is_enquiry_requester(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.can_read_conversation(uuid),app.not_suspended(),app.can_write_conversation(uuid),app.is_unclaimed_enquiry(uuid),app.is_enquiry_requester(uuid) TO plinth_app;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['conversations','participants','messages','enquiries'] LOOP
    EXECUTE format('ALTER TABLE messaging.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE messaging.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY hub_scope ON messaging.%I USING(hub_id=app.hub_id()) WITH CHECK(hub_id=app.hub_id())',t);
  END LOOP;
END $$;
-- Conversations are created together with an enquiry by its requester.
CREATE POLICY conversation_read ON messaging.conversations AS RESTRICTIVE FOR SELECT USING(app.can_read_conversation(id));
CREATE POLICY conversation_create ON messaging.conversations AS RESTRICTIVE FOR INSERT WITH CHECK(app.not_suspended());
CREATE POLICY participant_read ON messaging.participants AS RESTRICTIVE FOR SELECT USING(app.can_read_conversation(conversation_id));
-- People add only themselves: the requester when creating, a provider when replying.
CREATE POLICY participant_self ON messaging.participants AS RESTRICTIVE FOR INSERT
  WITH CHECK(user_id=app.user_id() AND ((role='requester' AND app.is_enquiry_requester(conversation_id))
    OR (role='provider' AND app.is_hub_admin() AND app.can_read_conversation(conversation_id))));
CREATE POLICY participant_update ON messaging.participants AS RESTRICTIVE FOR UPDATE
  USING(user_id=app.user_id()) WITH CHECK(user_id=app.user_id());
CREATE POLICY message_read ON messaging.messages AS RESTRICTIVE FOR SELECT USING(app.can_read_conversation(conversation_id));
CREATE POLICY message_send ON messaging.messages AS RESTRICTIVE FOR INSERT
  WITH CHECK(sender_id=app.user_id() AND app.can_write_conversation(conversation_id));
CREATE POLICY enquiry_read ON messaging.enquiries AS RESTRICTIVE FOR SELECT USING(requester_id=app.user_id() OR app.is_hub_admin());
CREATE POLICY enquiry_create ON messaging.enquiries AS RESTRICTIVE FOR INSERT
  WITH CHECK(requester_id=app.user_id() AND status='open' AND app.not_suspended() AND app.is_unclaimed_enquiry(conversation_id)
    AND (requester_org IS NULL OR EXISTS(SELECT 1 FROM identity.org_members WHERE user_id=app.user_id() AND org_id=requester_org AND status='active')));
CREATE POLICY enquiry_status ON messaging.enquiries AS RESTRICTIVE FOR UPDATE USING(app.is_hub_admin()) WITH CHECK(app.is_hub_admin());
CREATE FUNCTION app.touch_enquiry() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN NEW.updated_at:=now(); RETURN NEW; END $$;
CREATE TRIGGER enquiry_touch BEFORE UPDATE ON messaging.enquiries FOR EACH ROW EXECUTE FUNCTION app.touch_enquiry();
REVOKE ALL ON FUNCTION app.touch_enquiry() FROM PUBLIC;
GRANT USAGE ON SCHEMA messaging TO plinth_app;
GRANT SELECT,INSERT ON ALL TABLES IN SCHEMA messaging TO plinth_app;
GRANT UPDATE(last_read_at) ON messaging.participants TO plinth_app;
GRANT UPDATE(status) ON messaging.enquiries TO plinth_app;
COMMIT;
