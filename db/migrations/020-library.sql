BEGIN;
CREATE SCHEMA library;
-- Library items are hub-wide (never company-private). Access follows the same
-- decision path as lessons: public = open, members = hub members, tier = a tier
-- benefit naming the item, entitled = buyers of the linked product.
CREATE TABLE library.items (
  hub_id uuid NOT NULL REFERENCES tenancy.hubs(id),
  id uuid NOT NULL,
  -- Podcasts and videos arrive with protected assets; articles carry text.
  type text NOT NULL DEFAULT 'article' CHECK(type IN ('article')),
  title text NOT NULL CHECK(length(btrim(title)) BETWEEN 1 AND 200),
  summary text NOT NULL DEFAULT '' CHECK(length(summary)<=2000),
  body text NOT NULL DEFAULT '' CHECK(length(body)<=50000),
  visibility text NOT NULL CHECK(visibility IN ('public','members','tier','entitled')),
  required_product_id uuid,
  topics text[] NOT NULL DEFAULT '{}' CHECK(cardinality(topics)<=5),
  status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published','archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  PRIMARY KEY(hub_id,id),
  FOREIGN KEY(hub_id,required_product_id) REFERENCES catalogue.products(hub_id,id),
  CHECK((visibility='entitled')=(required_product_id IS NOT NULL))
);
CREATE INDEX library_published ON library.items(hub_id,status,published_at DESC,id);
CREATE INDEX library_topics ON library.items USING gin(topics);
ALTER TABLE library.items ENABLE ROW LEVEL SECURITY;
ALTER TABLE library.items FORCE ROW LEVEL SECURITY;
CREATE POLICY hub_scope ON library.items USING(hub_id=app.hub_id()) WITH CHECK(hub_id=app.hub_id());
CREATE POLICY admin_insert ON library.items AS RESTRICTIVE FOR INSERT WITH CHECK(app.is_hub_admin());
CREATE POLICY admin_update ON library.items AS RESTRICTIVE FOR UPDATE USING(app.is_hub_admin()) WITH CHECK(app.is_hub_admin());

-- Definer rights: the company-product check must see the product even when the
-- caller's row-level security would hide it.
CREATE FUNCTION app.guard_library_item() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE topic text;
BEGIN
  FOREACH topic IN ARRAY NEW.topics LOOP
    IF topic !~ '^[a-z0-9]+(-[a-z0-9]+)*$' OR length(topic)>40 THEN
      RAISE EXCEPTION 'Invalid topic' USING ERRCODE='22023';
    END IF;
  END LOOP;
  -- Linking to a company product would reveal it on the hub-wide library.
  IF NEW.required_product_id IS NOT NULL AND EXISTS(SELECT 1 FROM catalogue.products
    WHERE hub_id=NEW.hub_id AND id=NEW.required_product_id AND visibility='company') THEN
    RAISE EXCEPTION 'Library items cannot require a company product' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'draft' THEN RAISE EXCEPTION 'Items start as drafts' USING ERRCODE='23514'; END IF;
    NEW.published_at:=NULL;
  ELSE
    IF NEW.hub_id<>OLD.hub_id OR NEW.id<>OLD.id OR NEW.type<>OLD.type OR NEW.created_at<>OLD.created_at THEN
      RAISE EXCEPTION 'Item identity is fixed' USING ERRCODE='23514';
    END IF;
    IF NEW.status='draft' AND OLD.status<>'draft' THEN RAISE EXCEPTION 'Items cannot return to draft' USING ERRCODE='23514'; END IF;
    IF NEW.status='published' AND OLD.status<>'published' THEN NEW.published_at:=now(); END IF;
  END IF;
  NEW.updated_at:=now();
  RETURN NEW;
END $$;
CREATE TRIGGER library_guard BEFORE INSERT OR UPDATE ON library.items
  FOR EACH ROW EXECUTE FUNCTION app.guard_library_item();
REVOKE ALL ON FUNCTION app.guard_library_item() FROM PUBLIC;
GRANT USAGE ON SCHEMA library TO plinth_app;
GRANT SELECT,INSERT ON library.items TO plinth_app;
GRANT UPDATE(title,summary,body,visibility,required_product_id,topics,status) ON library.items TO plinth_app;
COMMIT;
