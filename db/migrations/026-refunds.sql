BEGIN;
ALTER TABLE commerce.orders DROP CONSTRAINT orders_status_check;
ALTER TABLE commerce.orders ADD CONSTRAINT orders_status_check CHECK(status IN ('pending','paid','failed','review','refunded'));
ALTER TABLE commerce.orders ADD COLUMN refunded_at timestamptz;
-- Refunds never edit sale entries: they add the same entries with sides swapped.
ALTER TABLE commerce.ledger_entries ADD COLUMN entry_type text NOT NULL DEFAULT 'sale' CHECK(entry_type IN ('sale','refund'));
GRANT UPDATE(revoked) ON access.entitlements TO plinth_commerce_executor;

CREATE OR REPLACE FUNCTION app.record_payment_event(p_provider text,p_event_id text,p_type text,p_reference text,
  p_amount_cents bigint,p_fee_cents bigint,p_payload_hash text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE o commerce.orders%ROWTYPE; line commerce.order_lines%ROWTYPE; outcome text; found_order boolean;
BEGIN
  IF p_fee_cents IS NULL OR p_fee_cents<0 OR p_amount_cents IS NULL THEN RAISE EXCEPTION 'Invalid event' USING ERRCODE='22023'; END IF;
  SELECT * INTO o FROM commerce.orders WHERE psp_provider=p_provider AND psp_reference=p_reference FOR UPDATE;
  found_order:=FOUND;
  IF found_order THEN
    -- Act inside the order's hub, as staff, so catalogue policies apply normally.
    PERFORM set_config('app.hub_id',o.hub_id::text,true),set_config('app.is_staff','true',true);
  END IF;
  IF NOT found_order THEN outcome:='unknown_reference';
  ELSIF p_type='payment.failed' THEN
    IF o.status='pending' THEN UPDATE commerce.orders SET status='failed' WHERE hub_id=o.hub_id AND id=o.id; outcome:='failed';
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
      outcome:='refunded';
    END IF;
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
COMMIT;
