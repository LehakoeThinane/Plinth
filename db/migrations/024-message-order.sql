BEGIN;
-- Read state and history order use a database sequence instead of timestamps.
-- Wall clocks can step (time synchronisation), which made a newer message look
-- older than a participant's last read time; sequence values only increase.
ALTER TABLE messaging.messages ADD COLUMN seq bigint GENERATED ALWAYS AS IDENTITY;
ALTER TABLE messaging.messages ADD CONSTRAINT message_seq UNIQUE(seq);
CREATE INDEX messages_order ON messaging.messages(hub_id,conversation_id,seq);
ALTER TABLE messaging.participants ADD COLUMN last_read_seq bigint NOT NULL DEFAULT 0;
-- Carry existing read positions over using the old timestamps once.
UPDATE messaging.participants p SET last_read_seq=coalesce((SELECT max(m.seq) FROM messaging.messages m
  WHERE m.hub_id=p.hub_id AND m.conversation_id=p.conversation_id AND m.created_at<=p.last_read_at),0)
  WHERE p.last_read_at IS NOT NULL;
GRANT UPDATE(last_read_seq) ON messaging.participants TO plinth_app;
COMMIT;
