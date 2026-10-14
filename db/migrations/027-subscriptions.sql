BEGIN;
-- Subscriptions to membership tiers or subscription-priced products. The first
-- payment activates them; renewals and failures arrive as signed provider events.
CREATE TABLE commerce.subscriptions (
  hub_id uuid NOT NULL REFERENCES tenancy.hubs(id),
  id uuid NOT NULL,
  subscriber_id uuid NOT NULL REFERENCES identity.users(id),
  tier_id uuid,
  plan_id uuid,
  product_id uuid,
  amount_cents bigint NOT NULL CHECK(amount_cents>0),
  billing_interval text NOT NULL CHECK(billing_interval IN ('month','year')),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','past_due','ended')),
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  current_period_end timestamptz,
  psp_provider text,
  psp_reference text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(hub_id,id),
  FOREIGN KEY(hub_id,tier_id) REFERENCES commerce.tiers(hub_id,id),
  FOREIGN KEY(hub_id,plan_id) REFERENCES catalogue.plans(hub_id,id),
  CHECK((tier_id IS NOT NULL)<>(plan_id IS NOT NULL)),
  CHECK((plan_id IS NULL)=(product_id IS NULL))
);
-- One live subscription per person and target. Pending ones (abandoned checkouts)
-- do not count, so they can never block subscribing again.
CREATE UNIQUE INDEX one_live_subscription ON commerce.subscriptions(hub_id,subscriber_id,coalesce(tier_id,product_id)) WHERE status IN ('active','past_due');

ALTER TABLE commerce.orders ADD COLUMN kind text NOT NULL DEFAULT 'purchase' CHECK(kind IN ('purchase','subscription_start','renewal'));
ALTER TABLE commerce.orders ADD COLUMN subscription_id uuid;
ALTER TABLE commerce.orders ADD CONSTRAINT order_subscription FOREIGN KEY(hub_id,subscription_id) REFERENCES commerce.subscriptions(hub_id,id);
-- Renewal orders are created by the executor and are not tied to a buyer request.
ALTER TABLE commerce.orders ALTER COLUMN idempotency_key DROP NOT NULL, ALTER COLUMN request_hash DROP NOT NULL;
ALTER TABLE commerce.orders ADD CONSTRAINT order_request CHECK(kind='renewal' OR (idempotency_key IS NOT NULL AND request_hash IS NOT NULL));
ALTER TABLE commerce.order_lines ALTER COLUMN plan_id DROP NOT NULL, ALTER COLUMN product_id DROP NOT NULL;
ALTER TABLE commerce.order_lines ADD COLUMN tier_id uuid;
ALTER TABLE commerce.order_lines ADD CONSTRAINT line_tier FOREIGN KEY(hub_id,tier_id) REFERENCES commerce.tiers(hub_id,id);
ALTER TABLE commerce.order_lines ADD CONSTRAINT line_target CHECK((tier_id IS NULL AND plan_id IS NOT NULL AND product_id IS NOT NULL)
  OR (tier_id IS NOT NULL AND plan_id IS NULL AND product_id IS NULL));
ALTER TABLE access.entitlements ADD COLUMN subscription_id uuid;
CREATE UNIQUE INDEX entitlement_per_subscription ON access.entitlements(hub_id,subscription_id) WHERE subscription_id IS NOT NULL;

ALTER TABLE commerce.subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce.subscriptions FORCE ROW LEVEL SECURITY;
CREATE POLICY hub_scope ON commerce.subscriptions USING(hub_id=app.hub_id() OR current_user='plinth_commerce_executor')
  WITH CHECK(hub_id=app.hub_id() OR current_user='plinth_commerce_executor');
CREATE POLICY subscriber_or_admin ON commerce.subscriptions AS RESTRICTIVE FOR SELECT
  USING(subscriber_id=app.user_id() OR app.is_hub_admin() OR current_user='plinth_commerce_executor');
CREATE POLICY subscriber_insert ON commerce.subscriptions AS RESTRICTIVE FOR INSERT TO plinth_app
  WITH CHECK(subscriber_id=app.user_id() AND status='pending' AND current_period_end IS NULL AND psp_reference IS NULL AND app.is_active_member());
-- Subscribers may only ask to stop at the end of the paid period.
CREATE POLICY subscriber_cancel ON commerce.subscriptions AS RESTRICTIVE FOR UPDATE TO plinth_app
  USING(subscriber_id=app.user_id() AND status IN ('active','past_due')) WITH CHECK(subscriber_id=app.user_id() AND cancel_at_period_end);
GRANT SELECT,INSERT ON commerce.subscriptions TO plinth_app;
GRANT UPDATE(cancel_at_period_end) ON commerce.subscriptions TO plinth_app;
-- Orders that start a subscription are created by the subscriber like purchases.
ALTER POLICY buyer_insert ON commerce.orders
  WITH CHECK(buyer_id=app.user_id() AND status='pending' AND paid_at IS NULL AND psp_reference IS NULL AND app.is_active_member()
    AND kind IN ('purchase','subscription_start'));
GRANT SELECT,UPDATE,INSERT ON commerce.subscriptions,commerce.orders TO plinth_commerce_executor;
GRANT INSERT ON commerce.order_lines TO plinth_commerce_executor;
GRANT SELECT ON commerce.tiers TO plinth_commerce_executor;
GRANT UPDATE(expires_at) ON access.entitlements TO plinth_commerce_executor;

-- Shared by first payments and renewals: balanced entries for one paid order.
CREATE FUNCTION app.post_sale(p_hub uuid,p_order uuid,p_total bigint,p_vat bigint,p_fee bigint) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
  INSERT INTO commerce.ledger_entries(hub_id,order_id,account,debit_cents) VALUES(p_hub,p_order,'buyer_payment',p_total);
  INSERT INTO commerce.ledger_entries(hub_id,order_id,account,credit_cents)
    SELECT p_hub,p_order,a,c FROM (VALUES('provider_revenue',p_total-p_vat-p_fee),('vat_payable',p_vat),('payment_fees',p_fee)) v(a,c) WHERE c>0;
$$;
CREATE FUNCTION app.next_period(p_from timestamptz,p_interval text) RETURNS timestamptz
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT p_from+CASE p_interval WHEN 'year' THEN interval '1 year' ELSE interval '1 month' END
$$;

CREATE OR REPLACE FUNCTION app.record_payment_event(p_provider text,p_event_id text,p_type text,p_reference text,
  p_amount_cents bigint,p_fee_cents bigint,p_payload_hash text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE o commerce.orders%ROWTYPE; s commerce.subscriptions%ROWTYPE; line commerce.order_lines%ROWTYPE;
  outcome text; found_order boolean; period_end timestamptz; violated text;
BEGIN
  IF p_fee_cents IS NULL OR p_fee_cents<0 OR p_amount_cents IS NULL THEN RAISE EXCEPTION 'Invalid event' USING ERRCODE='22023'; END IF;
  IF p_type LIKE 'subscription.%' THEN
    -- Renewal events name the subscription, not an order.
    SELECT * INTO s FROM commerce.subscriptions WHERE psp_provider=p_provider AND psp_reference=p_reference FOR UPDATE;
    IF NOT FOUND THEN outcome:='unknown_reference';
    ELSE
      PERFORM set_config('app.hub_id',s.hub_id::text,true),set_config('app.is_staff','true',true);
      IF s.status NOT IN ('active','past_due') OR s.cancel_at_period_end THEN outcome:='ignored';
      ELSIF p_type='subscription.renewal_failed' THEN
        -- Access continues for a 7-day grace period after a failed renewal.
        UPDATE commerce.subscriptions SET status='past_due' WHERE hub_id=s.hub_id AND id=s.id;
        UPDATE access.entitlements SET expires_at=s.current_period_end+interval '7 days' WHERE hub_id=s.hub_id AND subscription_id=s.id;
        outcome:='past_due';
      ELSIF p_type<>'subscription.renewed' THEN outcome:='ignored';
      ELSIF p_amount_cents<>s.amount_cents OR p_fee_cents>s.amount_cents THEN outcome:='review';
      ELSE
        period_end:=app.next_period(greatest(s.current_period_end,now()),s.billing_interval);
        INSERT INTO commerce.orders(hub_id,id,buyer_id,status,subtotal_cents,total_cents,kind,subscription_id,psp_provider,paid_at)
          VALUES(s.hub_id,gen_random_uuid(),s.subscriber_id,'paid',s.amount_cents,s.amount_cents,'renewal',s.id,p_provider,now())
          RETURNING * INTO o;
        INSERT INTO commerce.order_lines(hub_id,order_id,line,plan_id,product_id,tier_id,quantity,unit_amount_cents,amount_cents)
          VALUES(s.hub_id,o.id,1,s.plan_id,s.product_id,s.tier_id,1,s.amount_cents,s.amount_cents);
        PERFORM app.post_sale(s.hub_id,o.id,s.amount_cents,0,p_fee_cents);
        UPDATE commerce.subscriptions SET status='active',current_period_end=period_end WHERE hub_id=s.hub_id AND id=s.id;
        UPDATE access.entitlements SET expires_at=period_end WHERE hub_id=s.hub_id AND subscription_id=s.id;
        outcome:='renewed';
      END IF;
    END IF;
  ELSE
    SELECT * INTO o FROM commerce.orders WHERE psp_provider=p_provider AND psp_reference=p_reference FOR UPDATE;
    found_order:=FOUND;
    IF found_order THEN
      -- Act inside the order's hub, as staff, so catalogue policies apply normally.
      PERFORM set_config('app.hub_id',o.hub_id::text,true),set_config('app.is_staff','true',true);
    END IF;
    IF NOT found_order THEN outcome:='unknown_reference';
    ELSIF p_type='payment.failed' THEN
      IF o.status='pending' THEN
        UPDATE commerce.orders SET status='failed' WHERE hub_id=o.hub_id AND id=o.id;
        UPDATE commerce.subscriptions SET status='ended' WHERE hub_id=o.hub_id AND id=o.subscription_id AND status='pending';
        outcome:='failed';
      ELSE outcome:='ignored'; END IF;
    ELSIF p_type='payment.refunded' THEN
      IF o.status<>'paid' THEN outcome:='ignored';
      -- Only full refunds are applied; anything else is left for a person.
      ELSIF p_amount_cents<>o.total_cents THEN outcome:='refund_review';
      ELSE
        UPDATE commerce.orders SET status='refunded',refunded_at=now() WHERE hub_id=o.hub_id AND id=o.id;
        INSERT INTO commerce.ledger_entries(hub_id,order_id,account,debit_cents,credit_cents,entry_type)
          SELECT hub_id,order_id,account,credit_cents,debit_cents,'refund' FROM commerce.ledger_entries
          WHERE hub_id=o.hub_id AND order_id=o.id AND entry_type='sale' ORDER BY id;
        UPDATE access.entitlements SET revoked=true WHERE hub_id=o.hub_id AND order_id=o.id;
        -- Refunding a subscription's first payment ends the subscription and its access.
        IF o.kind='subscription_start' THEN
          UPDATE commerce.subscriptions SET status='ended' WHERE hub_id=o.hub_id AND id=o.subscription_id;
          UPDATE access.entitlements SET revoked=true WHERE hub_id=o.hub_id AND subscription_id=o.subscription_id;
        END IF;
        outcome:='refunded';
      END IF;
    ELSIF p_type<>'payment.succeeded' THEN outcome:='ignored';
    ELSIF o.status<>'pending' OR o.kind='renewal' THEN outcome:='ignored';
    -- A wrong amount never grants access; a person reviews it. Every line is
    -- re-checked against the immutable plan or published tier price, because
    -- application code wrote the order.
    ELSIF p_amount_cents<>o.total_cents OR p_fee_cents>o.total_cents-o.vat_cents
      OR EXISTS(SELECT 1 FROM commerce.order_lines l
        LEFT JOIN catalogue.plans p ON p.hub_id=l.hub_id AND p.id=l.plan_id
        LEFT JOIN commerce.tiers t ON t.hub_id=l.hub_id AND t.id=l.tier_id
        WHERE l.hub_id=o.hub_id AND l.order_id=o.id AND NOT CASE
          WHEN l.tier_id IS NOT NULL THEN o.kind='subscription_start' AND t.status='published' AND t.amount_cents=l.unit_amount_cents
          ELSE p.amount_cents=l.unit_amount_cents AND p.product_id=l.product_id
            AND p.model=CASE o.kind WHEN 'subscription_start' THEN 'subscription' ELSE 'once_off' END END)
      OR (SELECT coalesce(sum(amount_cents),0) FROM commerce.order_lines WHERE hub_id=o.hub_id AND order_id=o.id)<>o.subtotal_cents
      OR NOT EXISTS(SELECT 1 FROM commerce.order_lines WHERE hub_id=o.hub_id AND order_id=o.id)
      -- A second paid start while one is already live is held for a refund, never lost.
      OR (o.kind='subscription_start' AND EXISTS(SELECT 1 FROM commerce.subscriptions live JOIN commerce.subscriptions mine
        ON mine.hub_id=o.hub_id AND mine.id=o.subscription_id WHERE live.hub_id=o.hub_id AND live.subscriber_id=mine.subscriber_id
        AND coalesce(live.tier_id,live.product_id)=coalesce(mine.tier_id,mine.product_id) AND live.status IN ('active','past_due'))) THEN
      UPDATE commerce.orders SET status='review' WHERE hub_id=o.hub_id AND id=o.id; outcome:='review';
    ELSE
      UPDATE commerce.orders SET status='paid',paid_at=now() WHERE hub_id=o.hub_id AND id=o.id;
      PERFORM app.post_sale(o.hub_id,o.id,o.total_cents,o.vat_cents,p_fee_cents);
      IF o.kind='subscription_start' THEN
        SELECT * INTO s FROM commerce.subscriptions WHERE hub_id=o.hub_id AND id=o.subscription_id FOR UPDATE;
        period_end:=app.next_period(now(),s.billing_interval);
        UPDATE commerce.subscriptions SET status='active',current_period_end=period_end,psp_provider=o.psp_provider,psp_reference=o.psp_reference
          WHERE hub_id=s.hub_id AND id=s.id;
        INSERT INTO access.entitlements(hub_id,id,user_id,target_id,kind,source,order_id,subscription_id,expires_at)
          VALUES(o.hub_id,gen_random_uuid(),o.buyer_id,coalesce(s.tier_id,s.product_id),CASE WHEN s.tier_id IS NULL THEN 'product' ELSE 'tier' END,
            CASE WHEN s.tier_id IS NULL THEN 'purchase' ELSE 'tier' END,o.id,s.id,period_end);
      ELSE
        FOR line IN SELECT * FROM commerce.order_lines WHERE hub_id=o.hub_id AND order_id=o.id LOOP
          INSERT INTO access.entitlements(hub_id,id,user_id,target_id,kind,source,order_id)
            VALUES(o.hub_id,gen_random_uuid(),o.buyer_id,line.product_id,'product','purchase',o.id);
        END LOOP;
      END IF;
      outcome:='paid';
    END IF;
  END IF;
  INSERT INTO commerce.payment_events(provider,event_id,type,reference,payload_hash,outcome)
    VALUES(p_provider,p_event_id,p_type,p_reference,p_payload_hash,outcome);
  RETURN outcome;
EXCEPTION WHEN unique_violation THEN
  -- Only the same provider event id again counts as a duplicate (nothing above
  -- is kept). Any other uniqueness failure is a real error and must surface.
  GET STACKED DIAGNOSTICS violated=CONSTRAINT_NAME;
  IF violated='payment_events_pkey' THEN RETURN 'duplicate'; END IF;
  RAISE;
END $$;
REVOKE ALL ON FUNCTION app.post_sale(uuid,uuid,bigint,bigint,bigint),app.next_period(timestamptz,text) FROM PUBLIC;
GRANT plinth_commerce_executor TO CURRENT_USER;
GRANT CREATE ON SCHEMA app TO plinth_commerce_executor;
ALTER FUNCTION app.post_sale(uuid,uuid,bigint,bigint,bigint) OWNER TO plinth_commerce_executor;
ALTER FUNCTION app.next_period(timestamptz,text) OWNER TO plinth_commerce_executor;
REVOKE CREATE ON SCHEMA app FROM plinth_commerce_executor;
REVOKE plinth_commerce_executor FROM CURRENT_USER;
COMMIT;
