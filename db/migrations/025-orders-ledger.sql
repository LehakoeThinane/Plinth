BEGIN;
-- Flow A: an order is created pending at checkout; only a verified payment
-- webhook marks it paid, writes the ledger and grants the entitlement, all in
-- one transaction run by the constrained commerce executor.
CREATE TABLE commerce.orders (
  hub_id uuid NOT NULL REFERENCES tenancy.hubs(id),
  id uuid NOT NULL,
  buyer_id uuid NOT NULL REFERENCES identity.users(id),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','paid','failed','review')),
  currency text NOT NULL DEFAULT 'ZAR' CHECK(currency='ZAR'),
  subtotal_cents bigint NOT NULL CHECK(subtotal_cents>0),
  -- VAT is recorded once providers can register their VAT status; zero until then.
  vat_cents bigint NOT NULL DEFAULT 0 CHECK(vat_cents>=0),
  total_cents bigint NOT NULL CHECK(total_cents=subtotal_cents+vat_cents),
  idempotency_key text NOT NULL CHECK(idempotency_key ~ '^[A-Za-z0-9_-]{8,100}$'),
  request_hash text NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'),
  psp_provider text,
  psp_reference text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz,
  PRIMARY KEY(hub_id,id),
  UNIQUE(hub_id,buyer_id,idempotency_key)
);
CREATE TABLE commerce.order_lines (
  hub_id uuid NOT NULL,
  order_id uuid NOT NULL,
  line integer NOT NULL CHECK(line>0),
  plan_id uuid NOT NULL,
  product_id uuid NOT NULL,
  quantity integer NOT NULL CHECK(quantity=1),
  unit_amount_cents bigint NOT NULL CHECK(unit_amount_cents>0),
  amount_cents bigint NOT NULL CHECK(amount_cents=unit_amount_cents*quantity),
  PRIMARY KEY(hub_id,order_id,line),
  FOREIGN KEY(hub_id,order_id) REFERENCES commerce.orders(hub_id,id),
  FOREIGN KEY(hub_id,plan_id) REFERENCES catalogue.plans(hub_id,id),
  FOREIGN KEY(hub_id,product_id) REFERENCES catalogue.products(hub_id,id)
);
-- Every provider event is stored once; a repeat with the same id is ignored.
CREATE TABLE commerce.payment_events (
  provider text NOT NULL CHECK(length(provider) BETWEEN 1 AND 40),
  event_id text NOT NULL CHECK(length(event_id) BETWEEN 1 AND 200),
  type text NOT NULL CHECK(length(type) BETWEEN 1 AND 80),
  reference text NOT NULL,
  payload_hash text NOT NULL CHECK(payload_hash ~ '^[0-9a-f]{64}$'),
  outcome text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(provider,event_id)
);
-- Double-entry, whole cents, never edited: corrections are reversing entries.
CREATE TABLE commerce.ledger_entries (
  hub_id uuid NOT NULL,
  id bigint GENERATED ALWAYS AS IDENTITY,
  order_id uuid NOT NULL,
  account text NOT NULL CHECK(account IN ('buyer_payment','provider_revenue','vat_payable','payment_fees')),
  debit_cents bigint NOT NULL DEFAULT 0 CHECK(debit_cents>=0),
  credit_cents bigint NOT NULL DEFAULT 0 CHECK(credit_cents>=0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(hub_id,id),
  FOREIGN KEY(hub_id,order_id) REFERENCES commerce.orders(hub_id,id),
  CHECK((debit_cents=0)<>(credit_cents=0))
);
ALTER TABLE access.entitlements
  ADD COLUMN source text NOT NULL DEFAULT 'grant' CHECK(source IN ('grant','purchase','seat','tier')),
  ADD COLUMN order_id uuid;
CREATE UNIQUE INDEX entitlement_per_order ON access.entitlements(hub_id,order_id) WHERE order_id IS NOT NULL;

ALTER TABLE commerce.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce.orders FORCE ROW LEVEL SECURITY;
ALTER TABLE commerce.order_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce.order_lines FORCE ROW LEVEL SECURITY;
ALTER TABLE commerce.ledger_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce.ledger_entries FORCE ROW LEVEL SECURITY;
ALTER TABLE commerce.payment_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce.payment_events FORCE ROW LEVEL SECURITY;
CREATE POLICY hub_scope ON commerce.orders USING(hub_id=app.hub_id() OR current_user='plinth_commerce_executor')
  WITH CHECK(hub_id=app.hub_id() OR current_user='plinth_commerce_executor');
CREATE POLICY hub_scope ON commerce.order_lines USING(hub_id=app.hub_id() OR current_user='plinth_commerce_executor')
  WITH CHECK(hub_id=app.hub_id() OR current_user='plinth_commerce_executor');
CREATE POLICY hub_scope ON commerce.ledger_entries USING(hub_id=app.hub_id() OR current_user='plinth_commerce_executor')
  WITH CHECK(current_user='plinth_commerce_executor');
CREATE POLICY executor_scope ON commerce.payment_events USING(current_user='plinth_commerce_executor')
  WITH CHECK(current_user='plinth_commerce_executor');
-- Buyers see and create their own pending orders; owners/admins see the hub's
-- sales and ledger. Nobody but the executor can change an order's status.
CREATE POLICY buyer_or_admin ON commerce.orders AS RESTRICTIVE FOR SELECT
  USING(buyer_id=app.user_id() OR app.is_hub_admin() OR current_user='plinth_commerce_executor');
CREATE POLICY buyer_insert ON commerce.orders AS RESTRICTIVE FOR INSERT TO plinth_app
  WITH CHECK(buyer_id=app.user_id() AND status='pending' AND paid_at IS NULL AND psp_reference IS NULL AND app.is_active_member());
CREATE POLICY line_read ON commerce.order_lines AS RESTRICTIVE FOR SELECT
  USING(current_user='plinth_commerce_executor' OR app.is_hub_admin() OR EXISTS(SELECT 1 FROM commerce.orders o
    WHERE o.hub_id=order_lines.hub_id AND o.id=order_lines.order_id AND o.buyer_id=app.user_id()));
CREATE POLICY line_insert ON commerce.order_lines AS RESTRICTIVE FOR INSERT TO plinth_app
  WITH CHECK(EXISTS(SELECT 1 FROM commerce.orders o WHERE o.hub_id=order_lines.hub_id AND o.id=order_lines.order_id
    AND o.buyer_id=app.user_id() AND o.status='pending'));
CREATE POLICY ledger_admin ON commerce.ledger_entries AS RESTRICTIVE FOR SELECT
  USING(app.is_hub_admin() OR current_user='plinth_commerce_executor');
CREATE FUNCTION app.immutable_ledger() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'Ledger entries are never edited; post a reversing entry' USING ERRCODE='23514'; END $$;
CREATE TRIGGER ledger_immutable BEFORE UPDATE OR DELETE ON commerce.ledger_entries FOR EACH ROW EXECUTE FUNCTION app.immutable_ledger();
REVOKE ALL ON FUNCTION app.immutable_ledger() FROM PUBLIC;
GRANT SELECT,INSERT ON commerce.orders,commerce.order_lines TO plinth_app;
GRANT UPDATE(psp_provider,psp_reference) ON commerce.orders TO plinth_app;
CREATE POLICY buyer_attach ON commerce.orders AS RESTRICTIVE FOR UPDATE TO plinth_app
  USING(buyer_id=app.user_id() AND status='pending' AND psp_reference IS NULL)
  WITH CHECK(buyer_id=app.user_id() AND status='pending');
GRANT SELECT ON commerce.ledger_entries TO plinth_app;

GRANT USAGE ON SCHEMA app,commerce,access,catalogue,tenancy,identity TO plinth_commerce_executor;
GRANT SELECT,UPDATE ON commerce.orders TO plinth_commerce_executor;
GRANT SELECT ON commerce.order_lines,catalogue.products,catalogue.plans,tenancy.memberships,tenancy.boundaries TO plinth_commerce_executor;
GRANT SELECT,INSERT ON commerce.payment_events,commerce.ledger_entries TO plinth_commerce_executor;
GRANT SELECT,INSERT ON access.entitlements TO plinth_commerce_executor;
ALTER POLICY self_scope ON access.entitlements
  USING(user_id=app.user_id() OR current_user='plinth_commerce_executor')
  WITH CHECK(user_id=app.user_id() OR current_user='plinth_commerce_executor');
ALTER POLICY hub_scope ON access.entitlements
  USING(hub_id=app.hub_id() OR current_user='plinth_commerce_executor')
  WITH CHECK(hub_id=app.hub_id() OR current_user='plinth_commerce_executor');

-- Called only by the payments login after it has verified the provider's
-- signature. Returns what happened, for the event log and the HTTP reply.
CREATE FUNCTION app.record_payment_event(p_provider text,p_event_id text,p_type text,p_reference text,
  p_amount_cents bigint,p_fee_cents bigint,p_payload_hash text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE o commerce.orders%ROWTYPE; line commerce.order_lines%ROWTYPE; outcome text;
BEGIN
  IF p_fee_cents IS NULL OR p_fee_cents<0 OR p_amount_cents IS NULL THEN RAISE EXCEPTION 'Invalid event' USING ERRCODE='22023'; END IF;
  SELECT * INTO o FROM commerce.orders WHERE psp_provider=p_provider AND psp_reference=p_reference FOR UPDATE;
  IF FOUND THEN
    -- Act inside the order's hub, as staff, so catalogue policies apply normally.
    PERFORM set_config('app.hub_id',o.hub_id::text,true),set_config('app.is_staff','true',true);
  END IF;
  IF NOT FOUND THEN outcome:='unknown_reference';
  ELSIF p_type='payment.failed' THEN
    IF o.status='pending' THEN UPDATE commerce.orders SET status='failed' WHERE hub_id=o.hub_id AND id=o.id; outcome:='failed';
    ELSE outcome:='ignored'; END IF;
  ELSIF p_type<>'payment.succeeded' THEN outcome:='ignored';
  ELSIF o.status<>'pending' THEN outcome:='ignored';
  -- A wrong amount never grants access; a person reviews it. The order's own
  -- prices are re-checked against the immutable plans: application code wrote
  -- them, so they are not trusted on their own.
  ELSIF p_amount_cents<>o.total_cents OR p_fee_cents>o.total_cents-o.vat_cents
    OR EXISTS(SELECT 1 FROM commerce.order_lines l JOIN catalogue.plans p ON p.hub_id=l.hub_id AND p.id=l.plan_id
      WHERE l.hub_id=o.hub_id AND l.order_id=o.id AND (p.amount_cents<>l.unit_amount_cents OR p.product_id<>l.product_id OR p.model<>'once_off'))
    OR (SELECT coalesce(sum(amount_cents),0) FROM commerce.order_lines WHERE hub_id=o.hub_id AND order_id=o.id)<>o.subtotal_cents
    OR NOT EXISTS(SELECT 1 FROM commerce.order_lines WHERE hub_id=o.hub_id AND order_id=o.id) THEN
    UPDATE commerce.orders SET status='review' WHERE hub_id=o.hub_id AND id=o.id; outcome:='review';
  ELSE
    UPDATE commerce.orders SET status='paid',paid_at=now() WHERE hub_id=o.hub_id AND id=o.id;
    INSERT INTO commerce.ledger_entries(hub_id,order_id,account,debit_cents) VALUES(o.hub_id,o.id,'buyer_payment',o.total_cents);
    INSERT INTO commerce.ledger_entries(hub_id,order_id,account,credit_cents)
      SELECT o.hub_id,o.id,a,c FROM (VALUES('provider_revenue',o.total_cents-o.vat_cents-p_fee_cents),('vat_payable',o.vat_cents),('payment_fees',p_fee_cents)) v(a,c) WHERE c>0;
    FOR line IN SELECT * FROM commerce.order_lines WHERE hub_id=o.hub_id AND order_id=o.id LOOP
      INSERT INTO access.entitlements(hub_id,id,user_id,target_id,kind,source,order_id)
        VALUES(o.hub_id,gen_random_uuid(),o.buyer_id,line.product_id,'product','purchase',o.id);
    END LOOP;
    outcome:='paid';
  END IF;
  INSERT INTO commerce.payment_events(provider,event_id,type,reference,payload_hash,outcome)
    VALUES(p_provider,p_event_id,p_type,p_reference,p_payload_hash,outcome);
  RETURN outcome;
EXCEPTION WHEN unique_violation THEN
  -- The same provider event id again: nothing above is kept.
  RETURN 'duplicate';
END $$;
REVOKE ALL ON FUNCTION app.record_payment_event(text,text,text,text,bigint,bigint,text) FROM PUBLIC;
GRANT USAGE ON SCHEMA app TO plinth_payments;
GRANT EXECUTE ON FUNCTION app.record_payment_event(text,text,text,text,bigint,bigint,text) TO plinth_payments;
GRANT plinth_commerce_executor TO CURRENT_USER;
GRANT CREATE ON SCHEMA app TO plinth_commerce_executor;
ALTER FUNCTION app.record_payment_event(text,text,text,text,bigint,bigint,text) OWNER TO plinth_commerce_executor;
REVOKE CREATE ON SCHEMA app FROM plinth_commerce_executor;
REVOKE plinth_commerce_executor FROM CURRENT_USER;
COMMIT;
