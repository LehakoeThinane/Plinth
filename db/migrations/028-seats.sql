BEGIN;
-- Company seats (Flow B). A company holds seats for a product in a seat pool,
-- bought on the platform (per-seat price) or granted by the provider for a deal
-- paid off the platform. A company admin assigns seats to the company's members;
-- every seat is an ordinary entitlement, so access works exactly like a purchase.
CREATE TABLE commerce.seat_pools (
  hub_id uuid NOT NULL REFERENCES tenancy.hubs(id),
  id uuid NOT NULL,
  org_id uuid NOT NULL REFERENCES identity.organisations(id),
  product_id uuid NOT NULL,
  seats integer NOT NULL CHECK(seats BETWEEN 1 AND 10000),
  source text NOT NULL CHECK(source IN ('purchase','provider_grant')),
  order_id uuid,
  -- Grants move no money; the reference (for example a PO number) and grantor
  -- are the audit record.
  external_reference text CHECK(length(btrim(external_reference)) BETWEEN 1 AND 100),
  granted_by uuid REFERENCES identity.users(id),
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','ended')),
  -- Live seats. Every assignment updates this row, so concurrent assignments
  -- conflict instead of both reading an old count; the check is the last guard.
  assigned integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  PRIMARY KEY(hub_id,id),
  FOREIGN KEY(hub_id,product_id) REFERENCES catalogue.products(hub_id,id),
  FOREIGN KEY(hub_id,order_id) REFERENCES commerce.orders(hub_id,id),
  CHECK((source='purchase')=(order_id IS NOT NULL)),
  CHECK(source<>'provider_grant' OR (external_reference IS NOT NULL AND granted_by IS NOT NULL)),
  CHECK((status='ended')=(ended_at IS NOT NULL)),
  CHECK(assigned BETWEEN 0 AND seats)
);
CREATE UNIQUE INDEX seat_pool_per_order ON commerce.seat_pools(hub_id,order_id) WHERE order_id IS NOT NULL;
ALTER TABLE access.entitlements ADD COLUMN seat_pool_id uuid;
CREATE TABLE commerce.seat_assignments (
  hub_id uuid NOT NULL,
  pool_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES identity.users(id),
  entitlement_id uuid NOT NULL,
  assigned_by uuid NOT NULL REFERENCES identity.users(id),
  assigned_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  -- Null when the system ended the seat (a refund or an ended grant).
  revoked_by uuid REFERENCES identity.users(id),
  PRIMARY KEY(hub_id,entitlement_id),
  FOREIGN KEY(hub_id,pool_id) REFERENCES commerce.seat_pools(hub_id,id),
  FOREIGN KEY(hub_id,entitlement_id) REFERENCES access.entitlements(hub_id,id),
  CHECK(revoked_by IS NULL OR revoked_at IS NOT NULL)
);
-- One live seat per person per pool.
CREATE UNIQUE INDEX one_live_seat ON commerce.seat_assignments(hub_id,pool_id,user_id) WHERE revoked_at IS NULL;

-- Seat purchases are orders for a number of seats on behalf of an organisation.
ALTER TABLE commerce.orders ADD COLUMN seat_org uuid REFERENCES identity.organisations(id);
ALTER TABLE commerce.orders DROP CONSTRAINT orders_kind_check;
ALTER TABLE commerce.orders ADD CONSTRAINT orders_kind_check CHECK(kind IN ('purchase','subscription_start','renewal','seats'));
ALTER TABLE commerce.orders ADD CONSTRAINT seat_order_org CHECK((kind='seats')=(seat_org IS NOT NULL));
ALTER TABLE commerce.order_lines DROP CONSTRAINT order_lines_quantity_check;
ALTER TABLE commerce.order_lines ADD CONSTRAINT order_lines_quantity_check CHECK(quantity BETWEEN 1 AND 1000);
-- Only an active admin of the organisation can buy seats for it.
ALTER POLICY buyer_insert ON commerce.orders
  WITH CHECK(buyer_id=app.user_id() AND status='pending' AND paid_at IS NULL AND psp_reference IS NULL AND app.is_active_member()
    AND kind IN ('purchase','subscription_start','seats') AND (kind<>'seats' OR app.is_org_member(seat_org,true)));

ALTER TABLE commerce.seat_pools ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce.seat_pools FORCE ROW LEVEL SECURITY;
ALTER TABLE commerce.seat_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce.seat_assignments FORCE ROW LEVEL SECURITY;
-- No runtime grants: seats are read and changed only through the functions
-- below, which check the caller's hub or company role themselves.
CREATE POLICY hub_scope ON commerce.seat_pools USING(hub_id=app.hub_id()) WITH CHECK(hub_id=app.hub_id());
CREATE POLICY hub_scope ON commerce.seat_assignments USING(hub_id=app.hub_id()) WITH CHECK(hub_id=app.hub_id());
CREATE POLICY executor_scope ON commerce.seat_pools AS RESTRICTIVE
  USING(current_user IN ('plinth_seat_executor','plinth_commerce_executor'))
  WITH CHECK(current_user IN ('plinth_seat_executor','plinth_commerce_executor'));
CREATE POLICY executor_scope ON commerce.seat_assignments AS RESTRICTIVE
  USING(current_user IN ('plinth_seat_executor','plinth_commerce_executor'))
  WITH CHECK(current_user IN ('plinth_seat_executor','plinth_commerce_executor'));

GRANT USAGE ON SCHEMA app,commerce,access,catalogue,tenancy,identity TO plinth_seat_executor;
GRANT SELECT,INSERT ON commerce.seat_pools,commerce.seat_assignments TO plinth_seat_executor;
GRANT UPDATE(status,ended_at,assigned) ON commerce.seat_pools TO plinth_seat_executor,plinth_commerce_executor;
GRANT UPDATE(revoked_at,revoked_by) ON commerce.seat_assignments TO plinth_seat_executor,plinth_commerce_executor;
GRANT SELECT,INSERT ON commerce.seat_pools TO plinth_commerce_executor;
GRANT SELECT ON commerce.seat_assignments TO plinth_commerce_executor;
GRANT SELECT,INSERT ON access.entitlements TO plinth_seat_executor;
GRANT UPDATE(revoked) ON access.entitlements TO plinth_seat_executor;
GRANT SELECT ON catalogue.products,tenancy.boundaries,identity.organisations,identity.org_members,identity.users TO plinth_seat_executor;
GRANT SELECT,INSERT ON tenancy.memberships TO plinth_seat_executor;
GRANT UPDATE(status) ON tenancy.memberships TO plinth_seat_executor;
ALTER POLICY self_scope ON access.entitlements
  USING(user_id=app.user_id() OR current_user IN ('plinth_commerce_executor','plinth_seat_executor'))
  WITH CHECK(user_id=app.user_id() OR current_user IN ('plinth_commerce_executor','plinth_seat_executor'));
ALTER POLICY self_scope ON tenancy.memberships
  USING(user_id=app.user_id() OR current_user IN ('plinth_community_moderator','plinth_seat_executor'))
  WITH CHECK(user_id=app.user_id() OR current_user IN ('plinth_community_moderator','plinth_seat_executor'));
-- A seat can make someone an ordinary member, or bring back one who left; it
-- never creates staff or lifts a suspension.
CREATE POLICY seat_join ON tenancy.memberships AS RESTRICTIVE FOR INSERT TO plinth_seat_executor
  WITH CHECK(role='member' AND status='active');
CREATE POLICY seat_rejoin ON tenancy.memberships AS RESTRICTIVE FOR UPDATE TO plinth_seat_executor
  USING(role='member' AND status='ended') WITH CHECK(role='member' AND status='active');
ALTER POLICY self_scope ON identity.org_members
  USING(user_id=app.user_id() OR current_user IN ('plinth_identity_executor','plinth_seat_executor'))
  WITH CHECK(user_id=app.user_id() OR current_user='plinth_identity_executor');
ALTER POLICY member_scope ON identity.organisations
  USING(app.is_org_member(id) OR current_user IN ('plinth_identity_executor','plinth_seat_executor'))
  WITH CHECK(app.is_org_member(id,true) OR current_user='plinth_identity_executor');
-- Seat views show assignees' and members' display names, nothing else.
ALTER POLICY self_scope ON identity.users
  USING(id=app.user_id() OR current_user IN ('plinth_auth_executor','plinth_seat_executor'))
  WITH CHECK(id=app.user_id() OR current_user='plinth_auth_executor');

CREATE FUNCTION app.is_company_admin(p_org uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT EXISTS(SELECT 1 FROM identity.org_members WHERE org_id=p_org AND user_id=app.user_id() AND status='active' AND role='admin')
$$;

-- Hub owners/admins grant seats for a deal agreed and paid off the platform.
-- Retrying with the same pool id and the same details returns the same pool.
CREATE FUNCTION app.grant_seats(p_pool uuid,p_org uuid,p_product uuid,p_seats integer,p_reference text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE existing commerce.seat_pools%ROWTYPE; product_org uuid; product_mode text;
BEGIN
  IF app.user_id() IS NULL OR NOT app.is_hub_admin() THEN RAISE EXCEPTION 'Not found' USING ERRCODE='42501'; END IF;
  IF p_seats IS NULL OR p_seats NOT BETWEEN 1 AND 10000 OR p_reference IS NULL OR length(btrim(p_reference)) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'Invalid grant' USING ERRCODE='22023';
  END IF;
  SELECT * INTO existing FROM commerce.seat_pools WHERE hub_id=app.hub_id() AND id=p_pool;
  IF FOUND THEN
    IF existing.org_id=p_org AND existing.product_id=p_product AND existing.seats=p_seats AND existing.external_reference=btrim(p_reference)
      AND existing.source='provider_grant' THEN RETURN existing.id; END IF;
    RAISE EXCEPTION 'idempotency_key_reused' USING ERRCODE='23505';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM identity.organisations WHERE id=p_org) THEN RAISE EXCEPTION 'unknown_organisation' USING ERRCODE='23514'; END IF;
  -- Staff visibility so a company product's boundary can be read; set only after the admin check.
  PERFORM set_config('app.is_staff','true',true);
  SELECT p.access_mode,b.company_org INTO product_mode,product_org FROM catalogue.products p
    JOIN tenancy.boundaries b ON b.hub_id=p.hub_id AND b.id=p.boundary_id WHERE p.hub_id=app.hub_id() AND p.id=p_product;
  IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE='42501'; END IF;
  IF product_mode<>'entitled' THEN RAISE EXCEPTION 'not_a_paid_product' USING ERRCODE='23514'; END IF;
  -- A company product's seats can only go to its own company.
  IF product_org IS NOT NULL AND product_org<>p_org THEN RAISE EXCEPTION 'wrong_organisation' USING ERRCODE='23514'; END IF;
  INSERT INTO commerce.seat_pools(hub_id,id,org_id,product_id,seats,source,external_reference,granted_by)
    VALUES(app.hub_id(),p_pool,p_org,p_product,p_seats,'provider_grant',btrim(p_reference),app.user_id());
  RETURN p_pool;
END $$;

-- Ends a provider grant (for example when the contract ends): every seat in it ends.
CREATE FUNCTION app.end_seat_pool(p_pool uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE pool commerce.seat_pools%ROWTYPE;
BEGIN
  IF app.user_id() IS NULL OR NOT app.is_hub_admin() THEN RAISE EXCEPTION 'Not found' USING ERRCODE='42501'; END IF;
  SELECT * INTO pool FROM commerce.seat_pools WHERE hub_id=app.hub_id() AND id=p_pool FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE='42501'; END IF;
  -- Purchased seats end only through a refund.
  IF pool.source<>'provider_grant' THEN RAISE EXCEPTION 'purchased_seats' USING ERRCODE='23514'; END IF;
  IF pool.status='ended' THEN RETURN; END IF;
  UPDATE commerce.seat_pools SET status='ended',ended_at=now(),assigned=0 WHERE hub_id=pool.hub_id AND id=pool.id;
  UPDATE access.entitlements SET revoked=true WHERE hub_id=pool.hub_id AND seat_pool_id=pool.id AND NOT revoked;
  UPDATE commerce.seat_assignments SET revoked_at=now(),revoked_by=app.user_id() WHERE hub_id=pool.hub_id AND pool_id=pool.id AND revoked_at IS NULL;
END $$;

-- A company admin gives one of the company's seats to an active company member.
-- The pool row is locked and its count updated, so two admins can never hand
-- out the last seat twice: the later one fails to serialise and is retried.
CREATE FUNCTION app.assign_seat(p_pool uuid,p_user uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE pool commerce.seat_pools%ROWTYPE; held uuid; member_status text; granted uuid;
BEGIN
  IF app.user_id() IS NULL THEN RAISE EXCEPTION 'Not found' USING ERRCODE='42501'; END IF;
  SELECT * INTO pool FROM commerce.seat_pools WHERE hub_id=app.hub_id() AND id=p_pool FOR UPDATE;
  IF NOT FOUND OR NOT app.is_company_admin(pool.org_id) THEN RAISE EXCEPTION 'Not found' USING ERRCODE='42501'; END IF;
  IF pool.status<>'active' THEN RAISE EXCEPTION 'seats_ended' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS(SELECT 1 FROM identity.org_members WHERE org_id=pool.org_id AND user_id=p_user AND status='active') THEN
    RAISE EXCEPTION 'not_company_member' USING ERRCODE='23514';
  END IF;
  -- Assigning again is harmless: the existing seat is returned.
  SELECT entitlement_id INTO held FROM commerce.seat_assignments WHERE hub_id=pool.hub_id AND pool_id=pool.id AND user_id=p_user AND revoked_at IS NULL;
  IF FOUND THEN RETURN held; END IF;
  IF pool.assigned>=pool.seats THEN RAISE EXCEPTION 'no_seats_left' USING ERRCODE='23514'; END IF;
  SELECT status INTO member_status FROM tenancy.memberships WHERE hub_id=pool.hub_id AND user_id=p_user;
  IF member_status IS NULL THEN
    INSERT INTO tenancy.memberships(hub_id,user_id,role,status) VALUES(pool.hub_id,p_user,'member','active');
  ELSIF member_status='suspended' THEN RAISE EXCEPTION 'member_suspended' USING ERRCODE='23514';
  ELSIF member_status='ended' THEN
    UPDATE tenancy.memberships SET status='active' WHERE hub_id=pool.hub_id AND user_id=p_user;
    IF NOT FOUND THEN RAISE EXCEPTION 'member_suspended' USING ERRCODE='23514'; END IF;
  END IF;
  granted:=gen_random_uuid();
  INSERT INTO access.entitlements(hub_id,id,user_id,target_id,kind,source,seat_pool_id)
    VALUES(pool.hub_id,granted,p_user,pool.product_id,'product','seat',pool.id);
  INSERT INTO commerce.seat_assignments(hub_id,pool_id,user_id,entitlement_id,assigned_by)
    VALUES(pool.hub_id,pool.id,p_user,granted,app.user_id());
  UPDATE commerce.seat_pools SET assigned=assigned+1 WHERE hub_id=pool.hub_id AND id=pool.id;
  RETURN granted;
END $$;

-- The company admin, or the hub's owners/admins, take a seat back; access ends
-- at once and the seat is free again. Taking back a seat nobody holds is harmless.
CREATE FUNCTION app.revoke_seat(p_pool uuid,p_user uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE pool commerce.seat_pools%ROWTYPE; released uuid;
BEGIN
  IF app.user_id() IS NULL THEN RAISE EXCEPTION 'Not found' USING ERRCODE='42501'; END IF;
  SELECT * INTO pool FROM commerce.seat_pools WHERE hub_id=app.hub_id() AND id=p_pool FOR UPDATE;
  IF NOT FOUND OR NOT (app.is_company_admin(pool.org_id) OR app.is_hub_admin()) THEN RAISE EXCEPTION 'Not found' USING ERRCODE='42501'; END IF;
  UPDATE commerce.seat_assignments SET revoked_at=now(),revoked_by=app.user_id()
    WHERE hub_id=pool.hub_id AND pool_id=pool.id AND user_id=p_user AND revoked_at IS NULL RETURNING entitlement_id INTO released;
  IF released IS NULL THEN RETURN false; END IF;
  UPDATE access.entitlements SET revoked=true WHERE hub_id=pool.hub_id AND id=released;
  UPDATE commerce.seat_pools SET assigned=assigned-1 WHERE hub_id=pool.hub_id AND id=pool.id;
  RETURN true;
END $$;

-- What a company admin (p_org given) or the hub's owners/admins (p_org null)
-- may see about seats: pools, who holds each seat and, for company admins, the
-- members a seat can go to. Names only; no other personal data.
CREATE FUNCTION app.seat_overview(p_org uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE pools jsonb; members jsonb:='[]'::jsonb;
BEGIN
  IF app.user_id() IS NULL THEN RAISE EXCEPTION 'Not found' USING ERRCODE='42501'; END IF;
  IF p_org IS NULL THEN
    IF NOT app.is_hub_admin() THEN RAISE EXCEPTION 'Not found' USING ERRCODE='42501'; END IF;
  ELSIF NOT app.is_company_admin(p_org) THEN RAISE EXCEPTION 'Not found' USING ERRCODE='42501';
  END IF;
  -- Product titles: staff see every product; a company admin sees their company's.
  IF p_org IS NULL THEN PERFORM set_config('app.is_staff','true',true);
  ELSE PERFORM set_config('app.org_ids',jsonb_build_array(p_org)::text,true); END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',sp.id,'orgId',sp.org_id,'orgName',o.display_name,'productId',sp.product_id,
      'productTitle',p.title,'seats',sp.seats,'source',sp.source,'reference',sp.external_reference,'status',sp.status,'createdAt',sp.created_at,
      'holders',(SELECT coalesce(jsonb_agg(jsonb_build_object('userId',a.user_id,'name',u.display_name,'assignedAt',a.assigned_at,
          'stillMember',EXISTS(SELECT 1 FROM identity.org_members m WHERE m.org_id=sp.org_id AND m.user_id=a.user_id AND m.status='active'))
          ORDER BY a.assigned_at),'[]'::jsonb)
        FROM commerce.seat_assignments a JOIN identity.users u ON u.id=a.user_id
        WHERE a.hub_id=sp.hub_id AND a.pool_id=sp.id AND a.revoked_at IS NULL)) ORDER BY sp.status,sp.created_at DESC),'[]'::jsonb)
    INTO pools
    FROM commerce.seat_pools sp JOIN identity.organisations o ON o.id=sp.org_id
    LEFT JOIN catalogue.products p ON p.hub_id=sp.hub_id AND p.id=sp.product_id
    WHERE sp.hub_id=app.hub_id() AND (p_org IS NULL OR sp.org_id=p_org);
  IF p_org IS NOT NULL THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object('userId',m.user_id,'name',u.display_name) ORDER BY u.display_name,m.user_id),'[]'::jsonb)
      INTO members FROM identity.org_members m JOIN identity.users u ON u.id=m.user_id WHERE m.org_id=p_org AND m.status='active';
  END IF;
  RETURN jsonb_build_object('pools',pools,'members',members);
END $$;

-- Payment events, as in migration 027, plus seat purchases (a pool is created
-- when payment is confirmed) and their refunds (the pool and its seats end).
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
        -- Refunding a seat purchase ends the pool and every seat assigned from it.
        IF o.kind='seats' THEN
          UPDATE access.entitlements SET revoked=true WHERE hub_id=o.hub_id AND NOT revoked
            AND seat_pool_id IN (SELECT id FROM commerce.seat_pools WHERE hub_id=o.hub_id AND order_id=o.id);
          UPDATE commerce.seat_assignments SET revoked_at=now() WHERE hub_id=o.hub_id AND revoked_at IS NULL
            AND pool_id IN (SELECT id FROM commerce.seat_pools WHERE hub_id=o.hub_id AND order_id=o.id);
          UPDATE commerce.seat_pools SET status='ended',ended_at=now(),assigned=0 WHERE hub_id=o.hub_id AND order_id=o.id AND status='active';
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
          WHEN l.tier_id IS NOT NULL THEN o.kind='subscription_start' AND t.status='published' AND t.amount_cents=l.unit_amount_cents AND l.quantity=1
          ELSE p.amount_cents=l.unit_amount_cents AND p.product_id=l.product_id AND (o.kind='seats' OR l.quantity=1)
            AND p.model=CASE o.kind WHEN 'subscription_start' THEN 'subscription' WHEN 'seats' THEN 'per_seat' ELSE 'once_off' END END)
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
      ELSIF o.kind='seats' THEN
        -- Seats go to the organisation as a pool; nobody has access until assigned.
        FOR line IN SELECT * FROM commerce.order_lines WHERE hub_id=o.hub_id AND order_id=o.id LOOP
          INSERT INTO commerce.seat_pools(hub_id,id,org_id,product_id,seats,source,order_id)
            VALUES(o.hub_id,gen_random_uuid(),o.seat_org,line.product_id,line.quantity,'purchase',o.id);
        END LOOP;
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

REVOKE ALL ON FUNCTION app.is_company_admin(uuid),app.grant_seats(uuid,uuid,uuid,integer,text),app.end_seat_pool(uuid),
  app.assign_seat(uuid,uuid),app.revoke_seat(uuid,uuid),app.seat_overview(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.is_company_admin(uuid) TO plinth_seat_executor,plinth_app;
GRANT EXECUTE ON FUNCTION app.grant_seats(uuid,uuid,uuid,integer,text),app.end_seat_pool(uuid),
  app.assign_seat(uuid,uuid),app.revoke_seat(uuid,uuid),app.seat_overview(uuid) TO plinth_app;
GRANT plinth_seat_executor TO CURRENT_USER;
GRANT CREATE ON SCHEMA app TO plinth_seat_executor;
ALTER FUNCTION app.grant_seats(uuid,uuid,uuid,integer,text) OWNER TO plinth_seat_executor;
ALTER FUNCTION app.end_seat_pool(uuid) OWNER TO plinth_seat_executor;
ALTER FUNCTION app.assign_seat(uuid,uuid) OWNER TO plinth_seat_executor;
ALTER FUNCTION app.revoke_seat(uuid,uuid) OWNER TO plinth_seat_executor;
ALTER FUNCTION app.seat_overview(uuid) OWNER TO plinth_seat_executor;
REVOKE CREATE ON SCHEMA app FROM plinth_seat_executor;
REVOKE plinth_seat_executor FROM CURRENT_USER;
COMMIT;
