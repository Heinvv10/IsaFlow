-- 954: Budget controls and collaboration (budgets programme P5, PR P5-1;
-- spec docs/plans/budgets/P5-controls-spec.md §2, census
-- docs/plans/budgets/P5-census.md, contract docs/plans/budgets/00-shared-contract.md).
--
-- WHAT (every table new, every column nullable or defaulted; nothing existing moves).
--   budget_control_settings  one row per company: the approval check policy
--     (off | warn | block, default warn, decision 8), the alert email flag (OFF,
--     decision 9) and the default alert thresholds. No row = the defaults.
--   budget_alert_thresholds  per account (or account slice) threshold overrides.
--   budget_alerts  one row per crossing of a threshold (unique = the dedupe key).
--   user_notifications  per-user in-app notifications (the header bell). Generic;
--     the first producers are budgets.
--   budget_check_events  every budget check outcome at approval; INSERT and
--     SELECT only for the app pools, so an override record cannot be rewritten.
--   po_items.cc1_id / cc2_id / bu_id  the dimensions a PO line commits against
--     (RESTRICT FKs exactly as 870 on supplier_invoice_items).
--   budget_holders, budget_slice_reviews  budget-holder workspaces (decision 9a).
--     The holder slice-write trigger on budget_month_amounts is NOT here: it
--     ships with the slice workflow (P5-6).
--
-- RULES IN THE DATABASE.
--   - Tenancy: every new table with company_id carries 944's forced-RLS policy
--     verbatim, except user_notifications, whose read and update policies ALSO
--     require user_id = auth.uid() (the session's own rows only; withAuth sets
--     the claim). Its INSERT policy is the tenant only: an evaluator notifies
--     other members, and a notification INSERTed for another user must not use
--     RETURNING (the row fails the read policy).
--   - Same company: version, CC1, CC2 and BU by composite FK (947's form, NO
--     ACTION so a company delete cascades); accounts by trigger (gl_accounts has
--     no (company_id, id) key), as 949 does; CC1/CC2 kinds by 947's
--     budget_month_amounts_dimension_kinds(). po_items has no company_id (RLS-less,
--     scoped through purchase_orders, 246b): its dimensions must belong to the
--     parent order's company (trigger).
--   - Column privileges: ids and creation stamps take their defaults (a
--     writable stamp gets forged); budget_check_events has no UPDATE or DELETE.
--   - Stamps (review round 2): actor stamps are the session user (auth.uid()) and
--     time stamps the clock, set by triggers; a notification goes to a member of
--     its company only; an event names its own company's document.
--   - The cron runs on the service pool (app_service, no claims): it reaches
--     these tables through the USING (true) mirrors app_service_sync_policies()
--     (915) creates from the app_user policies. Both migration appliers call it
--     after applying; it is called here too so the file is whole on its own.
--
-- Every function here is SECURITY INVOKER: no app_definer_reviews row (930).

SET LOCAL lock_timeout = '5s';

-- ── budget_control_settings ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS budget_control_settings (
  company_id UUID PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  check_policy TEXT NOT NULL DEFAULT 'warn' CHECK (check_policy IN ('off', 'warn', 'block')),
  alert_email_enabled BOOLEAN NOT NULL DEFAULT false,
  default_thresholds NUMERIC[] NOT NULL DEFAULT '{80,100,120}',
  updated_by VARCHAR(255),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 1-10 percentages in (0, 1000], one dimension, no NULL (`0 < ALL` is NULL, so passes, on a NULL element).
  CONSTRAINT budget_control_settings_thresholds CHECK (
    array_ndims(default_thresholds) = 1 AND cardinality(default_thresholds) BETWEEN 1 AND 10
    AND array_position(default_thresholds, NULL) IS NULL
    AND 0 < ALL (default_thresholds) AND 1000 >= ALL (default_thresholds))
);
DROP TRIGGER IF EXISTS trg_budget_control_settings_updated_at ON budget_control_settings;
CREATE TRIGGER trg_budget_control_settings_updated_at BEFORE UPDATE ON budget_control_settings
  FOR EACH ROW EXECUTE FUNCTION accounting_updated_at();

-- ── budget_alert_thresholds ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS budget_alert_thresholds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  gl_account_id UUID NOT NULL REFERENCES gl_accounts(id) ON DELETE CASCADE,
  cc1_id UUID,
  cc2_id UUID,
  bu_id UUID,
  thresholds NUMERIC[] NOT NULL,
  created_by VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by VARCHAR(255),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT budget_alert_thresholds_values CHECK (
    array_ndims(thresholds) = 1 AND cardinality(thresholds) BETWEEN 1 AND 10
    AND array_position(thresholds, NULL) IS NULL
    AND 0 < ALL (thresholds) AND 1000 >= ALL (thresholds)),
  -- A slice is one dimension (decision 14).
  CONSTRAINT budget_alert_thresholds_one_dimension CHECK (num_nonnulls(cc1_id, cc2_id, bu_id) <= 1),
  CONSTRAINT budget_alert_thresholds_one_per_slice
    UNIQUE NULLS NOT DISTINCT (company_id, gl_account_id, cc1_id, cc2_id, bu_id),
  CONSTRAINT budget_alert_thresholds_cc1_fk FOREIGN KEY (company_id, cc1_id) REFERENCES cost_centres (company_id, id),
  CONSTRAINT budget_alert_thresholds_cc2_fk FOREIGN KEY (company_id, cc2_id) REFERENCES cost_centres (company_id, id),
  CONSTRAINT budget_alert_thresholds_bu_fk FOREIGN KEY (company_id, bu_id) REFERENCES business_units (company_id, id)
);
CREATE INDEX IF NOT EXISTS idx_bat_cc1 ON budget_alert_thresholds (cc1_id) WHERE cc1_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bat_cc2 ON budget_alert_thresholds (cc2_id) WHERE cc2_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bat_bu ON budget_alert_thresholds (bu_id) WHERE bu_id IS NOT NULL;
DROP TRIGGER IF EXISTS trg_budget_alert_thresholds_updated_at ON budget_alert_thresholds;
CREATE TRIGGER trg_budget_alert_thresholds_updated_at BEFORE UPDATE ON budget_alert_thresholds
  FOR EACH ROW EXECUTE FUNCTION accounting_updated_at();

-- ── budget_alerts ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS budget_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  version_id UUID NOT NULL,
  gl_account_id UUID NOT NULL REFERENCES gl_accounts(id) ON DELETE CASCADE,
  cc1_id UUID,
  cc2_id UUID,
  bu_id UUID,
  month DATE NOT NULL CHECK (EXTRACT(DAY FROM month) = 1),
  threshold NUMERIC NOT NULL CHECK (threshold > 0),
  budget NUMERIC(15, 2) NOT NULL,
  actual NUMERIC(15, 2) NOT NULL,
  committed NUMERIC(15, 2) NOT NULL,
  pct NUMERIC NOT NULL,
  fired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  CONSTRAINT budget_alerts_one_dimension CHECK (num_nonnulls(cc1_id, cc2_id, bu_id) <= 1),
  CONSTRAINT budget_alerts_one_per_crossing
    UNIQUE NULLS NOT DISTINCT (company_id, version_id, gl_account_id, cc1_id, cc2_id, bu_id, month, threshold),
  CONSTRAINT budget_alerts_version_fk
    FOREIGN KEY (company_id, version_id) REFERENCES budget_versions (company_id, id) ON DELETE CASCADE,
  CONSTRAINT budget_alerts_cc1_fk FOREIGN KEY (company_id, cc1_id) REFERENCES cost_centres (company_id, id),
  CONSTRAINT budget_alerts_cc2_fk FOREIGN KEY (company_id, cc2_id) REFERENCES cost_centres (company_id, id),
  CONSTRAINT budget_alerts_bu_fk FOREIGN KEY (company_id, bu_id) REFERENCES business_units (company_id, id)
);
CREATE INDEX IF NOT EXISTS idx_budget_alerts_company_fired ON budget_alerts (company_id, fired_at DESC);
CREATE INDEX IF NOT EXISTS idx_ba_cc1 ON budget_alerts (cc1_id) WHERE cc1_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ba_cc2 ON budget_alerts (cc2_id) WHERE cc2_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ba_bu ON budget_alerts (bu_id) WHERE bu_id IS NOT NULL;

-- ── user_notifications ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS user_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  -- users.id is TEXT (348). No FK: company_users.user_id has none either.
  user_id VARCHAR(255) NOT NULL CHECK (btrim(user_id) <> ''),
  kind TEXT NOT NULL CHECK (kind IN ('budget_alert', 'budget_slice', 'budget_reminder')),
  ref_id UUID,
  title TEXT NOT NULL CHECK (btrim(title) <> '' AND length(title) <= 200),
  body TEXT CHECK (length(body) <= 2000),
  -- An in-app path only ('/accounting/...'): never a scheme, never protocol-relative ('//host', '/\host'), and no
  -- control character or white space anywhere: a URL parser strips tab/LF/CR, so '/<TAB>/evil.com' is '//evil.com'
  -- (src/lib/inAppPath.ts is the same rule).
  href TEXT CHECK (href IS NULL OR (length(href) <= 500 AND left(href, 1) = '/' AND substr(href, 2, 1) NOT IN ('/', '\')
                                    AND href !~ '[[:cntrl:][:space:]\u0080-\u009f]')),
  dedupe_key TEXT NOT NULL CHECK (btrim(dedupe_key) <> '' AND length(dedupe_key) <= 200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at TIMESTAMPTZ,
  CONSTRAINT user_notifications_dedupe UNIQUE (company_id, user_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS idx_user_notifications_feed ON user_notifications (company_id, user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_notifications_unread
  ON user_notifications (company_id, user_id) WHERE read_at IS NULL;

-- ── budget_check_events ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS budget_check_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  document_type TEXT NOT NULL CHECK (document_type IN ('supplier_invoice', 'purchase_order')),
  document_id UUID NOT NULL,
  policy TEXT NOT NULL CHECK (policy IN ('off', 'warn', 'block')),
  outcome TEXT NOT NULL CHECK (outcome IN ('pass', 'warn', 'override', 'refused')),
  lines JSONB NOT NULL CHECK (jsonb_typeof(lines) = 'array'),
  reason TEXT CHECK (length(reason) <= 2000),
  channel TEXT NOT NULL CHECK (channel IN ('ui', 'bulk', 'mcp', 'system')),
  -- The session's user (auth.uid()); budget_check_events_check overwrites anything sent.
  decided_by VARCHAR(255) NOT NULL DEFAULT auth.uid(),
  decided_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_budget_check_events_document
  ON budget_check_events (company_id, document_type, document_id, decided_at DESC);

-- ── po_items dimensions (870's form on supplier_invoice_items) ──────────────

ALTER TABLE po_items
  ADD COLUMN IF NOT EXISTS cc1_id UUID REFERENCES cost_centres(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS cc2_id UUID REFERENCES cost_centres(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS bu_id  UUID REFERENCES business_units(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS idx_poi_cc1 ON po_items (cc1_id) WHERE cc1_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_poi_cc2 ON po_items (cc2_id) WHERE cc2_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_poi_bu  ON po_items (bu_id)  WHERE bu_id  IS NOT NULL;

-- A PO line's dimensions belong to its order's company, CC1/CC2 of their kind. Runs as the
-- session: a centre, unit or order it cannot see is refused (fails closed).
CREATE OR REPLACE FUNCTION public.po_items_dimensions_check()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  co uuid; t text;
BEGIN
  SELECT po.company_id INTO co FROM purchase_orders po WHERE po.id = NEW.purchase_order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'purchase order % not found for PO line dimensions', NEW.purchase_order_id USING ERRCODE = '23503';
  END IF;
  IF NEW.cc1_id IS NOT NULL THEN
    SELECT cc.cc_type INTO t FROM cost_centres cc WHERE cc.id = NEW.cc1_id AND cc.company_id = co;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'PO line cc1_id % is not a cost centre of company %', NEW.cc1_id, co USING ERRCODE = '23503';
    END IF;
    IF t IS DISTINCT FROM 'cc1' THEN
      RAISE EXCEPTION 'PO line cc1_id % is not a CC1 cost centre', NEW.cc1_id USING ERRCODE = '23514';
    END IF;
  END IF;
  t := NULL;
  IF NEW.cc2_id IS NOT NULL THEN
    SELECT cc.cc_type INTO t FROM cost_centres cc WHERE cc.id = NEW.cc2_id AND cc.company_id = co;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'PO line cc2_id % is not a cost centre of company %', NEW.cc2_id, co USING ERRCODE = '23503';
    END IF;
    IF t IS DISTINCT FROM 'cc2' THEN
      RAISE EXCEPTION 'PO line cc2_id % is not a CC2 cost centre', NEW.cc2_id USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.bu_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM business_units b WHERE b.id = NEW.bu_id AND b.company_id = co) THEN
    RAISE EXCEPTION 'PO line bu_id % is not a business unit of company %', NEW.bu_id, co USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_po_items_dimensions_check ON po_items;
CREATE TRIGGER trg_po_items_dimensions_check
  BEFORE INSERT OR UPDATE OF purchase_order_id, cc1_id, cc2_id, bu_id ON po_items
  FOR EACH ROW WHEN (NEW.cc1_id IS NOT NULL OR NEW.cc2_id IS NOT NULL OR NEW.bu_id IS NOT NULL)
  EXECUTE FUNCTION public.po_items_dimensions_check();
ALTER TABLE po_items ENABLE ALWAYS TRIGGER trg_po_items_dimensions_check;

-- ── budget_holders ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS budget_holders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  version_id UUID NOT NULL,
  user_id VARCHAR(255) NOT NULL CHECK (btrim(user_id) <> ''),
  cc1_id UUID,
  cc2_id UUID,
  bu_id UUID,
  -- NULL: every account of the slice; else these accounts only.
  gl_account_ids UUID[] CHECK (gl_account_ids IS NULL OR (
    array_ndims(gl_account_ids) = 1 AND cardinality(gl_account_ids) BETWEEN 1 AND 1000
    AND array_position(gl_account_ids, NULL) IS NULL)),
  created_by VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT budget_holders_one_dimension CHECK (num_nonnulls(cc1_id, cc2_id, bu_id) <= 1),
  CONSTRAINT budget_holders_one_per_slice
    UNIQUE NULLS NOT DISTINCT (company_id, version_id, user_id, cc1_id, cc2_id, bu_id),
  CONSTRAINT budget_holders_version_fk
    FOREIGN KEY (company_id, version_id) REFERENCES budget_versions (company_id, id) ON DELETE CASCADE,
  CONSTRAINT budget_holders_cc1_fk FOREIGN KEY (company_id, cc1_id) REFERENCES cost_centres (company_id, id),
  CONSTRAINT budget_holders_cc2_fk FOREIGN KEY (company_id, cc2_id) REFERENCES cost_centres (company_id, id),
  CONSTRAINT budget_holders_bu_fk FOREIGN KEY (company_id, bu_id) REFERENCES business_units (company_id, id)
);
CREATE INDEX IF NOT EXISTS idx_budget_holders_user ON budget_holders (company_id, user_id);
CREATE INDEX IF NOT EXISTS idx_bh_cc1 ON budget_holders (cc1_id) WHERE cc1_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bh_cc2 ON budget_holders (cc2_id) WHERE cc2_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bh_bu ON budget_holders (bu_id) WHERE bu_id IS NOT NULL;

-- ── budget_slice_reviews ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS budget_slice_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  version_id UUID NOT NULL,
  cc1_id UUID,
  cc2_id UUID,
  bu_id UUID,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'submitted', 'returned', 'approved')),
  due_date DATE,
  submitted_by VARCHAR(255),
  submitted_at TIMESTAMPTZ,
  decided_by VARCHAR(255),
  decided_at TIMESTAMPTZ,
  decision_note TEXT CHECK (length(decision_note) <= 2000),
  created_by VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT budget_slice_reviews_one_dimension CHECK (num_nonnulls(cc1_id, cc2_id, bu_id) <= 1),
  CONSTRAINT budget_slice_reviews_one_per_slice
    UNIQUE NULLS NOT DISTINCT (company_id, version_id, cc1_id, cc2_id, bu_id),
  CONSTRAINT budget_slice_reviews_version_fk
    FOREIGN KEY (company_id, version_id) REFERENCES budget_versions (company_id, id) ON DELETE CASCADE,
  CONSTRAINT budget_slice_reviews_cc1_fk FOREIGN KEY (company_id, cc1_id) REFERENCES cost_centres (company_id, id),
  CONSTRAINT budget_slice_reviews_cc2_fk FOREIGN KEY (company_id, cc2_id) REFERENCES cost_centres (company_id, id),
  CONSTRAINT budget_slice_reviews_bu_fk FOREIGN KEY (company_id, bu_id) REFERENCES business_units (company_id, id)
);
CREATE INDEX IF NOT EXISTS idx_bsr_cc1 ON budget_slice_reviews (cc1_id) WHERE cc1_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bsr_cc2 ON budget_slice_reviews (cc2_id) WHERE cc2_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bsr_bu ON budget_slice_reviews (bu_id) WHERE bu_id IS NOT NULL;
DROP TRIGGER IF EXISTS trg_budget_slice_reviews_updated_at ON budget_slice_reviews;
CREATE TRIGGER trg_budget_slice_reviews_updated_at BEFORE UPDATE ON budget_slice_reviews
  FOR EACH ROW EXECUTE FUNCTION accounting_updated_at();

-- ── Same company: accounts (and a holder's account list) by trigger ─────────
-- gl_accounts has no (company_id, id) key to point a composite FK at (949's reason). Reads the
-- row as jsonb so one function serves every table that names an account.
CREATE OR REPLACE FUNCTION public.budget_controls_same_company()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  j jsonb := to_jsonb(NEW);
  acct uuid := NULLIF(j ->> 'gl_account_id', '')::uuid;
  ids uuid[];
BEGIN
  IF acct IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM gl_accounts ga WHERE ga.id = acct AND ga.company_id = NEW.company_id) THEN
    RAISE EXCEPTION '% account % does not belong to company %', TG_TABLE_NAME, acct, NEW.company_id USING ERRCODE = '23514';
  END IF;
  IF jsonb_typeof(j -> 'gl_account_ids') = 'array' THEN
    SELECT array_agg(e::uuid) INTO ids FROM jsonb_array_elements_text(j -> 'gl_account_ids') e;
    IF EXISTS (SELECT 1 FROM unnest(ids) a
                WHERE NOT EXISTS (SELECT 1 FROM gl_accounts ga WHERE ga.id = a AND ga.company_id = NEW.company_id)) THEN
      RAISE EXCEPTION '% names an account that does not belong to company %', TG_TABLE_NAME, NEW.company_id USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['budget_alert_thresholds', 'budget_alerts', 'budget_holders'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', 'trg_' || t || '_same_company', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE ON %I FOR EACH ROW '
                   'EXECUTE FUNCTION public.budget_controls_same_company()', 'trg_' || t || '_same_company', t);
    EXECUTE format('ALTER TABLE %I ENABLE ALWAYS TRIGGER %I', t, 'trg_' || t || '_same_company');
  END LOOP;
  -- CC1/CC2 kinds on every slice (947's check reads only NEW.company_id, cc1_id, cc2_id).
  FOREACH t IN ARRAY ARRAY['budget_alert_thresholds', 'budget_alerts', 'budget_holders', 'budget_slice_reviews'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', 'trg_' || t || '_dimension_kinds', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OF company_id, cc1_id, cc2_id ON %I FOR EACH ROW '
                   'EXECUTE FUNCTION public.budget_month_amounts_dimension_kinds()', 'trg_' || t || '_dimension_kinds', t);
    EXECUTE format('ALTER TABLE %I ENABLE ALWAYS TRIGGER %I', t, 'trg_' || t || '_dimension_kinds');
  END LOOP;
END;
$$;

-- A centre a threshold, alert, holder, slice review or PO line names keeps its kind (947/949's
-- guards cover amounts and drivers). Under RLS a session sees only the active company's rows;
-- 947's guard (same trigger point) already refuses a change from another company. po_items has
-- no company_id: its order's company decides.
CREATE OR REPLACE FUNCTION public.cost_centres_keep_control_kind()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM budget_alert_thresholds x WHERE x.company_id = OLD.company_id AND OLD.id IN (x.cc1_id, x.cc2_id))
     OR EXISTS (SELECT 1 FROM budget_holders x WHERE x.company_id = OLD.company_id AND OLD.id IN (x.cc1_id, x.cc2_id))
     OR EXISTS (SELECT 1 FROM budget_slice_reviews x WHERE x.company_id = OLD.company_id AND OLD.id IN (x.cc1_id, x.cc2_id))
     OR EXISTS (SELECT 1 FROM budget_alerts x WHERE x.company_id = OLD.company_id AND OLD.id IN (x.cc1_id, x.cc2_id))
     OR EXISTS (SELECT 1 FROM po_items x JOIN purchase_orders po ON po.id = x.purchase_order_id
                 WHERE po.company_id = OLD.company_id AND OLD.id IN (x.cc1_id, x.cc2_id)) THEN
    RAISE EXCEPTION 'cost centre % is used by budget controls; its kind (cc_type) cannot change', OLD.id USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_cost_centres_keep_control_kind ON cost_centres;
CREATE TRIGGER trg_cost_centres_keep_control_kind BEFORE UPDATE OF cc_type ON cost_centres
  FOR EACH ROW WHEN (OLD.cc_type IS DISTINCT FROM NEW.cc_type) EXECUTE FUNCTION public.cost_centres_keep_control_kind();
ALTER TABLE cost_centres ENABLE ALWAYS TRIGGER trg_cost_centres_keep_control_kind;

-- ── Recipients, documents and stamps (review round 2) ───────────────────────
-- Writable stamps get forged: every actor stamp an app session writes is the session's own user
-- (auth.uid(), the claim withAuth sets), every time stamp the clock. With no session user (the
-- service pool's cron, a migration) the writer's actor value stands; the columns that need one are
-- NOT NULL. Claims are forgeable by injected SQL, as every app_user policy here assumes (915).

-- A notification's recipient is a member of the row's company. The invoker reads company_users
-- directly (the service pool's mirror, an owner/admin, or the user themself); a manager notifying
-- an owner cannot see that row (cu_self_or_admin), so 714's reviewed definer answers instead,
-- bound to the caller's own active company. No new definer.
CREATE OR REPLACE FUNCTION public.user_notification_recipient_ok(p_company uuid, p_user text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM company_users cu WHERE cu.company_id = p_company AND cu.user_id = p_user) THEN
    RETURN true;
  END IF;
  IF auth.uid() IS NULL OR app.current_company_id() IS DISTINCT FROM p_company THEN
    RETURN false;
  END IF;
  RETURN public.approval_company_member_name(p_company, p_user) IS NOT NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.user_notifications_check()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NOT public.user_notification_recipient_ok(NEW.company_id, NEW.user_id) THEN
    RAISE EXCEPTION 'notification recipient % is not a member of company %', NEW.user_id, NEW.company_id USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_user_notifications_check ON user_notifications;
CREATE TRIGGER trg_user_notifications_check BEFORE INSERT OR UPDATE OF company_id, user_id ON user_notifications
  FOR EACH ROW EXECUTE FUNCTION public.user_notifications_check();
ALTER TABLE user_notifications ENABLE ALWAYS TRIGGER trg_user_notifications_check;

-- An event names a document of its own company, of its own type; the session user decides it.
CREATE OR REPLACE FUNCTION public.budget_check_events_check()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF (NEW.document_type = 'supplier_invoice'
      AND NOT EXISTS (SELECT 1 FROM supplier_invoices d WHERE d.id = NEW.document_id AND d.company_id = NEW.company_id))
     OR (NEW.document_type = 'purchase_order'
      AND NOT EXISTS (SELECT 1 FROM purchase_orders d WHERE d.id = NEW.document_id AND d.company_id = NEW.company_id)) THEN
    RAISE EXCEPTION 'budget check event: % % is not a document of company %', NEW.document_type, NEW.document_id, NEW.company_id
      USING ERRCODE = '23503';
  END IF;
  NEW.decided_by := COALESCE(auth.uid(), NEW.decided_by);
  NEW.decided_at := clock_timestamp();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_budget_check_events_check ON budget_check_events;
CREATE TRIGGER trg_budget_check_events_check BEFORE INSERT ON budget_check_events
  FOR EACH ROW EXECUTE FUNCTION public.budget_check_events_check();
ALTER TABLE budget_check_events ENABLE ALWAYS TRIGGER trg_budget_check_events_check;

-- A slice review's actors and times come from the status move itself: submitted stamps the
-- submitter, approved/returned the decider. A move with no session user is refused (no actor to stamp).
CREATE OR REPLACE FUNCTION public.budget_slice_reviews_stamp()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  uid text := auth.uid();
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_by := COALESCE(uid, NEW.created_by);
    NEW.submitted_by := NULL; NEW.submitted_at := NULL; NEW.decided_by := NULL; NEW.decided_at := NULL;
    RETURN NEW;
  END IF;
  NEW.created_by := OLD.created_by;
  NEW.submitted_by := OLD.submitted_by; NEW.submitted_at := OLD.submitted_at;
  NEW.decided_by := OLD.decided_by; NEW.decided_at := OLD.decided_at;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF uid IS NULL THEN
      RAISE EXCEPTION 'a budget slice status change needs a session user' USING ERRCODE = '42501';
    END IF;
    IF NEW.status = 'submitted' THEN
      NEW.submitted_by := uid; NEW.submitted_at := clock_timestamp();
    ELSIF NEW.status IN ('approved', 'returned') THEN
      NEW.decided_by := uid; NEW.decided_at := clock_timestamp();
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_budget_slice_reviews_stamp ON budget_slice_reviews;
CREATE TRIGGER trg_budget_slice_reviews_stamp BEFORE INSERT OR UPDATE ON budget_slice_reviews
  FOR EACH ROW EXECUTE FUNCTION public.budget_slice_reviews_stamp();
ALTER TABLE budget_slice_reviews ENABLE ALWAYS TRIGGER trg_budget_slice_reviews_stamp;

-- An alert's fired_at is the clock's: set at insert, re-stamped only when a resolved alert fires
-- again (resolved_at cleared); resolved_at is the clock's when it is set.
CREATE OR REPLACE FUNCTION public.budget_alerts_stamp()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  NEW.fired_at := CASE WHEN OLD.resolved_at IS NOT NULL AND NEW.resolved_at IS NULL THEN clock_timestamp() ELSE OLD.fired_at END;
  IF NEW.resolved_at IS NOT NULL THEN
    NEW.resolved_at := COALESCE(OLD.resolved_at, clock_timestamp());
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_budget_alerts_stamp ON budget_alerts;
CREATE TRIGGER trg_budget_alerts_stamp BEFORE UPDATE ON budget_alerts
  FOR EACH ROW EXECUTE FUNCTION public.budget_alerts_stamp();
ALTER TABLE budget_alerts ENABLE ALWAYS TRIGGER trg_budget_alerts_stamp;

-- The other actor stamps: the session user overwrites what is sent. TG_ARGV[0] is the column an
-- INSERT stamps, TG_ARGV[1] the one an UPDATE stamps ('-': none).
CREATE OR REPLACE FUNCTION public.budget_controls_stamp_actor()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  uid text := auth.uid();
  col text := CASE TG_OP WHEN 'INSERT' THEN TG_ARGV[0] ELSE TG_ARGV[1] END;
BEGIN
  IF uid IS NULL OR col = '-' THEN
    RETURN NEW;
  END IF;
  NEW := jsonb_populate_record(NEW, jsonb_build_object(col, uid));
  RETURN NEW;
END;
$$;
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES ('budget_control_settings', 'updated_by', 'updated_by'),
                                 ('budget_alert_thresholds', 'created_by', 'updated_by'),
                                 ('budget_holders', 'created_by', '-')) v(t, ins, upd) LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', 'trg_' || r.t || '_stamp_actor', r.t);
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE ON %I FOR EACH ROW '
                   'EXECUTE FUNCTION public.budget_controls_stamp_actor(%L, %L)', 'trg_' || r.t || '_stamp_actor', r.t, r.ins, r.upd);
    EXECUTE format('ALTER TABLE %I ENABLE ALWAYS TRIGGER %I', r.t, 'trg_' || r.t || '_stamp_actor');
  END LOOP;
END;
$$;

-- ── Tenancy: 944's policy, verbatim, on each budget table ───────────────────

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['budget_control_settings', 'budget_alert_thresholds', 'budget_alerts',
                           'budget_check_events', 'budget_holders', 'budget_slice_reviews'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL TO app_user '
      'USING (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies())) '
      'WITH CHECK (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()))', t);
    -- 348's default privileges gave app_user every command: take back all but SELECT, then grant per column below.
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON %I FROM app_user', t);
    EXECUTE format('GRANT SELECT ON %I TO app_user', t);
  END LOOP;
END;
$$;

-- user_notifications: the tenant AND the session's own user for reads and updates.
ALTER TABLE user_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_notifications FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS user_notifications_read_own ON user_notifications;
CREATE POLICY user_notifications_read_own ON user_notifications FOR SELECT TO app_user
  USING (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()) AND user_id = auth.uid());
DROP POLICY IF EXISTS user_notifications_update_own ON user_notifications;
CREATE POLICY user_notifications_update_own ON user_notifications FOR UPDATE TO app_user
  USING (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()) AND user_id = auth.uid())
  WITH CHECK (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()) AND user_id = auth.uid());
DROP POLICY IF EXISTS user_notifications_insert ON user_notifications;
CREATE POLICY user_notifications_insert ON user_notifications FOR INSERT TO app_user
  WITH CHECK (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()));
REVOKE INSERT, UPDATE, DELETE ON user_notifications FROM app_user;
GRANT SELECT ON user_notifications TO app_user;

-- INSERT per column: ids and stamps take their defaults. UPDATE per column: never id,
-- company_id or the creation stamps. budget_check_events: INSERT only (no UPDATE, no DELETE).
GRANT INSERT (company_id, check_policy, alert_email_enabled, default_thresholds, updated_by)
  ON budget_control_settings TO app_user;
GRANT UPDATE (check_policy, alert_email_enabled, default_thresholds, updated_by, updated_at)
  ON budget_control_settings TO app_user;
GRANT INSERT (company_id, gl_account_id, cc1_id, cc2_id, bu_id, thresholds, created_by)
  ON budget_alert_thresholds TO app_user;
GRANT UPDATE (thresholds, updated_by, updated_at) ON budget_alert_thresholds TO app_user;
GRANT DELETE ON budget_alert_thresholds TO app_user;
GRANT INSERT (company_id, version_id, gl_account_id, cc1_id, cc2_id, bu_id, month, threshold, budget, actual, committed, pct)
  ON budget_alerts TO app_user;
-- fired_at and resolved_at are the clock's (budget_alerts_stamp): resolved_at is granted only so a
-- writer can set or clear it; the value written is replaced.
GRANT UPDATE (budget, actual, committed, pct, resolved_at) ON budget_alerts TO app_user;
GRANT INSERT (company_id, user_id, kind, ref_id, title, body, href, dedupe_key) ON user_notifications TO app_user;
GRANT UPDATE (read_at) ON user_notifications TO app_user;
GRANT INSERT (company_id, document_type, document_id, policy, outcome, lines, reason, channel, decided_by)
  ON budget_check_events TO app_user;
GRANT INSERT (company_id, version_id, user_id, cc1_id, cc2_id, bu_id, gl_account_ids, created_by)
  ON budget_holders TO app_user;
GRANT UPDATE (gl_account_ids) ON budget_holders TO app_user;
GRANT DELETE ON budget_holders TO app_user;
GRANT INSERT (company_id, version_id, cc1_id, cc2_id, bu_id, due_date, created_by) ON budget_slice_reviews TO app_user;
-- Actor and time stamps are budget_slice_reviews_stamp's: never app-writable.
GRANT UPDATE (status, due_date, decision_note, updated_at) ON budget_slice_reviews TO app_user;
GRANT DELETE ON budget_slice_reviews TO app_user;

REVOKE ALL ON FUNCTION public.po_items_dimensions_check() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.budget_controls_same_company() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cost_centres_keep_control_kind() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.user_notifications_check() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.budget_check_events_check() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.budget_slice_reviews_stamp() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.budget_alerts_stamp() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.budget_controls_stamp_actor() FROM PUBLIC;
-- notifyUsers asks it before writing, so a non-member is a plain error, not a 23503 mid-transaction.
REVOKE ALL ON FUNCTION public.user_notification_recipient_ok(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.user_notification_recipient_ok(uuid, text) TO app_user;

-- The service pool (cron, after-commit work) reaches the new tables through these mirrors.
SELECT public.app_service_sync_policies();
