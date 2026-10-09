-- 877: Bank controls (forensic-controls rebuild, step 2; Hein's decisions
-- 2026-10-09). Builds on the R-035 switchboard (approval_enforcement) and
-- step 1's pattern (876): append-only evidence, RLS binding the tenant AND the
-- actor, a BEFORE INSERT guard, and WHO-may-approve decided in TypeScript on
-- the R-035 rank ladder (bank/bankRuleApprovers.ts) — and re-checked here on
-- the same ladder (bank_control_rank), the raised approver role included.
--
--   1. Import provenance: bank_import_batches gains file_sha256 and
--      import_channel; imported_by, file_sha256 and import_channel never
--      change once set (the importer is who may NOT allocate the batch's
--      lines under enforcement — bank/bankLineImporterGate.ts); a batch row a
--      line names cannot be deleted, and a line's batch cannot move.
--   2. Bank rule history: bank_rule_changes, one row per change to a rule in
--      bank_categorisation_rules — written by a trigger on the rules table
--      itself for every write that lands (UI, MCP, seed, merge, raw SQL), and
--      by bank/bankRuleChangeControl.ts for a change HELD for approval (status
--      'pending', never applied to the rules table until approved).
--   3. Decisions on held changes: bank_rule_change_decisions (approved /
--      rejected / superseded) — append-only, so a change's state is DERIVED
--      (its status, then its decision), never UPDATEd. No UPDATE grant exists
--      on either table: the alternative, a SECURITY DEFINER status writer,
--      would be a second privileged writer to census; an append-only decision
--      row carries the decider, the time, the note and the sole-approver
--      roster, and a UNIQUE (change_id) makes a second decision impossible.
--   4. The backstop on the rules table: under the `bank_rule` switch, a write
--      that makes a rule post money (bank_rule_posts_money: auto-posting, or
--      any active rule while auto-post is on), or changes anything but its
--      cosmetic columns while it does, is refused unless it applies a change a
--      person approved in this same transaction.
--   5. approval_enforcement accepts 'bank_rule'.
--
-- Boundary (as N1 and 876): the app connects as a superuser and drops to
-- app_user, so injected SQL can RESET ROLE or set its own claims. These
-- objects bind application code paths and app_user statements, not an
-- attacker who already runs arbitrary SQL.

-- ── 1. Import provenance ──────────────────────────────────────────────────
ALTER TABLE bank_import_batches ADD COLUMN IF NOT EXISTS file_sha256 TEXT;
ALTER TABLE bank_import_batches ADD COLUMN IF NOT EXISTS import_channel TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bank_import_batches_file_sha256_ck') THEN
    ALTER TABLE bank_import_batches ADD CONSTRAINT bank_import_batches_file_sha256_ck
      CHECK (file_sha256 IS NULL OR file_sha256 ~ '^[0-9a-f]{64}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bank_import_batches_import_channel_ck') THEN
    ALTER TABLE bank_import_batches ADD CONSTRAINT bank_import_batches_import_channel_ck
      CHECK (import_channel IS NULL OR import_channel IN ('upload', 'mcp', 'extension', 'statement_ocr', 'classified'));
  END IF;
END $$;

-- Once recorded, provenance is fixed: re-pointing imported_by to someone else
-- would let the importer allocate their own batch. Setting it from NULL (a
-- legacy batch) only ever names a person who may then NOT allocate.
CREATE OR REPLACE FUNCTION public.bank_import_batch_provenance_fixed() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF (OLD.imported_by IS NOT NULL AND NEW.imported_by IS DISTINCT FROM OLD.imported_by)
     OR (OLD.file_sha256 IS NOT NULL AND NEW.file_sha256 IS DISTINCT FROM OLD.file_sha256)
     OR (OLD.import_channel IS NOT NULL AND NEW.import_channel IS DISTINCT FROM OLD.import_channel)
     OR NEW.company_id IS DISTINCT FROM OLD.company_id THEN
    RAISE EXCEPTION 'bank_import_batches: who imported a batch, from what file and through which channel cannot change'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS bank_import_batch_provenance_fixed ON bank_import_batches;
CREATE TRIGGER bank_import_batch_provenance_fixed
  BEFORE UPDATE ON bank_import_batches
  FOR EACH ROW EXECUTE FUNCTION public.bank_import_batch_provenance_fixed();

-- Nor can provenance be shed (breaker #684 REPRO 5): a line whose batch row is
-- gone, or whose import_batch_id moved, names no importer. A batch row goes
-- only once no line names it (MCP undo_bank_import deletes the lines, never
-- the batch) or with its company; a line's batch, once set, never changes.
CREATE OR REPLACE FUNCTION public.bank_import_batch_kept() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.companies c WHERE c.id = OLD.company_id)
     AND EXISTS (SELECT 1 FROM public.bank_transactions t WHERE t.import_batch_id = OLD.id) THEN
    RAISE EXCEPTION 'bank_import_batches: batch % cannot be deleted while a bank line still names it', OLD.id
      USING ERRCODE = '42501';
  END IF;
  RETURN OLD;
END
$$;

DROP TRIGGER IF EXISTS bank_import_batch_kept ON bank_import_batches;
CREATE TRIGGER bank_import_batch_kept
  BEFORE DELETE ON bank_import_batches
  FOR EACH ROW EXECUTE FUNCTION public.bank_import_batch_kept();

-- A line's provenance — its import batch and its feed connection — is what it
-- was written with, in both directions (breaker round 2, R2-3): a hand-keyed
-- line GIVEN a colleague's batch, or any line re-pointed to a feed, would pass
-- as evidence and escape the hand-keyed gate. Nothing in the application
-- changes either column after INSERT (bankImportProvenanceCensus).
CREATE OR REPLACE FUNCTION public.bank_transaction_batch_fixed() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'bank_transactions: line %''s import batch and feed connection are its provenance and cannot change', OLD.id
    USING ERRCODE = '42501';
END
$$;

DROP TRIGGER IF EXISTS bank_transaction_batch_fixed ON bank_transactions;
CREATE TRIGGER bank_transaction_batch_fixed
  BEFORE UPDATE OF import_batch_id, bank_feed_connection_id ON bank_transactions
  FOR EACH ROW WHEN (NEW.import_batch_id IS DISTINCT FROM OLD.import_batch_id
                     OR NEW.bank_feed_connection_id IS DISTINCT FROM OLD.bank_feed_connection_id)
  EXECUTE FUNCTION public.bank_transaction_batch_fixed();

-- ── 2. What a rule is, and when a change to it needs approval ─────────────
-- A rule's projection: every column but its identity and bookkeeping. Read by
-- the triggers below and by the TypeScript (the stale check), never
-- re-implemented. A column added later is in it automatically (fails closed:
-- a new column is a gated column until it is listed as cosmetic).
CREATE OR REPLACE FUNCTION public.bank_rule_projection(p_row pg_catalog.jsonb) RETURNS pg_catalog.jsonb
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT p_row - ARRAY['id', 'company_id', 'created_by', 'created_at', 'updated_at']::pg_catalog.text[]
$$;

-- Whether a rule (as projected) POSTS MONEY unattended in its company: an
-- active rule that either auto-posts itself (auto_create_entry:
-- bankRulesMatchingService posts a journal per matched line) or whose
-- company has auto-post on — smart-categorize matches every active rule (at
-- 0.95) and autoPostGateService.sweep posts the suggestion unattended
-- (breaker #684 REPRO 4). auto_apply ('fifo'/'none') is not a switch: it says
-- how a supplier rule's cash is applied, so it is a posting target (gated below).
-- Replaces 877's first, company-blind bank_rule_auto_posts(jsonb).
-- The 3-argument form takes auto-post as given (asking "had auto-post been
-- on"); the 2-argument form reads the company's setting. One definition.
DROP FUNCTION IF EXISTS public.bank_rule_auto_posts(pg_catalog.jsonb);
CREATE OR REPLACE FUNCTION public.bank_rule_posts_money(p_company_id pg_catalog.uuid, p pg_catalog.jsonb,
  p_auto_post_on pg_catalog.bool)
RETURNS pg_catalog.bool
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT p IS NOT NULL AND (p ->> 'is_active') = 'true' AND ((p ->> 'auto_create_entry') = 'true' OR p_auto_post_on)
$$;

CREATE OR REPLACE FUNCTION public.bank_rule_auto_post_on(p_company_id pg_catalog.uuid) RETURNS pg_catalog.bool
LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT EXISTS (SELECT 1 FROM public.bank_auto_post_settings s WHERE s.company_id = p_company_id AND s.enabled)
$$;

CREATE OR REPLACE FUNCTION public.bank_rule_posts_money(p_company_id pg_catalog.uuid, p pg_catalog.jsonb)
RETURNS pg_catalog.bool
LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT public.bank_rule_posts_money(p_company_id, p, public.bank_rule_auto_post_on(p_company_id))
$$;

-- Hein's decision 3: a change needs a different person's approval (under the
-- `bank_rule` switch) when afterwards the rule posts money and either it did
-- not before (created posting, auto_create_entry or is_active turned on) or
-- anything but a cosmetic column moved — what it matches, where it posts
-- (account, supplier, customer, VAT code, auto_apply), its priority. Turning
-- auto-post off, disabling and deleting never do; nor does any change to a
-- rule that posts nothing (inactive, or suggest-only with auto-post off).
DROP FUNCTION IF EXISTS public.bank_rule_change_needs_approval(pg_catalog.jsonb, pg_catalog.jsonb);
CREATE OR REPLACE FUNCTION public.bank_rule_change_needs_approval(p_company_id pg_catalog.uuid, p_before pg_catalog.jsonb,
  p_after pg_catalog.jsonb, p_auto_post_on pg_catalog.bool)
RETURNS pg_catalog.bool
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT public.bank_rule_posts_money(p_company_id, p_after, p_auto_post_on) AND (
    NOT public.bank_rule_posts_money(p_company_id, p_before, p_auto_post_on)
    OR (p_before - ARRAY['rule_name', 'description_template', 'notes']::pg_catalog.text[])
       IS DISTINCT FROM (p_after - ARRAY['rule_name', 'description_template', 'notes']::pg_catalog.text[]))
$$;

CREATE OR REPLACE FUNCTION public.bank_rule_change_needs_approval(p_company_id pg_catalog.uuid, p_before pg_catalog.jsonb,
  p_after pg_catalog.jsonb)
RETURNS pg_catalog.bool
LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT public.bank_rule_change_needs_approval(p_company_id, p_before, p_after, public.bank_rule_auto_post_on(p_company_id))
$$;

-- ── 3. The history ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bank_rule_changes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seq         BIGINT GENERATED ALWAYS AS IDENTITY,
  -- The history goes with its company: a purged company's rows cascade
  -- (the one delete the append-only trigger lets through).
  company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  -- NULL only for a creation held for approval (the rule does not exist yet;
  -- its approval names the id it is created with).
  rule_id     UUID,
  kind        TEXT NOT NULL CHECK (kind IN ('create', 'update', 'toggle', 'delete', 'seed', 'merge')),
  before      JSONB,
  after       JSONB,
  -- users.id is character varying(255), not uuid.
  proposed_by TEXT NOT NULL,
  proposed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status      TEXT NOT NULL CHECK (status IN ('applied', 'pending')),
  CONSTRAINT bank_rule_changes_company_id_uq UNIQUE (id, company_id),
  CONSTRAINT bank_rule_changes_shape_ck CHECK (
    (kind IN ('create', 'seed')) = (before IS NULL) AND (kind = 'delete') = (after IS NULL)),
  CONSTRAINT bank_rule_changes_rule_ck CHECK (
    (status = 'applied' AND rule_id IS NOT NULL)
    OR (status = 'pending' AND kind IN ('create', 'update', 'toggle') AND (kind = 'create') = (rule_id IS NULL)))
);
-- When the change was RECORDED (clock_timestamp(), by the guard below), as
-- opposed to proposed_at (now(): its transaction's start, which other checks
-- use as a "this transaction" marker). Rule writers record only after taking
-- bankRuleAutoPostLock's shared lock, so recorded_at orders a change against
-- auto-post's switch-off and bank_rule's switch-on (breaker R3-1). NULL on rows
-- recorded before this column: readers fall back to proposed_at.
ALTER TABLE bank_rule_changes ADD COLUMN IF NOT EXISTS recorded_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS bank_rule_changes_rule_idx ON bank_rule_changes (company_id, rule_id, seq DESC);
CREATE INDEX IF NOT EXISTS bank_rule_changes_pending_idx ON bank_rule_changes (company_id, seq DESC) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS bank_rule_change_decisions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  change_id       UUID NOT NULL,
  decision        TEXT NOT NULL CHECK (decision IN ('approved', 'rejected', 'superseded')),
  decided_by      TEXT NOT NULL,
  decided_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  note            TEXT CHECK (note IS NULL OR (pg_catalog.char_length(pg_catalog.btrim(note)) BETWEEN 1 AND 500)),
  -- A proposer deciding their own change as the sole approver (R-035 Q2 on
  -- the admin floor): the roster it was allowed on.
  roster_snapshot JSONB,
  -- An approved change: the rule it applies to (for a creation, the id the
  -- rule is created with).
  rule_id         UUID,
  CONSTRAINT bank_rule_change_decisions_one UNIQUE (change_id),
  CONSTRAINT bank_rule_change_decisions_change_fk FOREIGN KEY (change_id, company_id)
    REFERENCES bank_rule_changes(id, company_id) ON DELETE CASCADE,
  CONSTRAINT bank_rule_change_decisions_shape_ck CHECK (
    (decision = 'approved') = (rule_id IS NOT NULL)
    AND (decision <> 'superseded' OR (note IS NULL AND roster_snapshot IS NULL)))
);

-- The derived state of every change: applied, pending, or its decision.
CREATE OR REPLACE VIEW bank_rule_change_states WITH (security_invoker = true) AS
  SELECT c.id, c.seq, c.company_id, COALESCE(c.rule_id, d.rule_id) AS rule_id, c.kind, c.before, c.after,
         c.proposed_by, c.proposed_at, COALESCE(d.decision, c.status) AS status,
         d.decided_by, d.decided_at, d.note AS decision_note, d.roster_snapshot, c.recorded_at
  FROM bank_rule_changes c
  LEFT JOIN bank_rule_change_decisions d ON d.change_id = c.id AND d.company_id = c.company_id;

ALTER TABLE bank_rule_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_rule_changes FORCE ROW LEVEL SECURITY;
ALTER TABLE bank_rule_change_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_rule_change_decisions FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'bank_rule_changes'
                 AND policyname = 'tenant_isolation') THEN
    CREATE POLICY tenant_isolation ON bank_rule_changes
      TO app_user
      USING (company_id IN (SELECT auth.user_companies()))
      WITH CHECK (company_id = app.current_company_id() AND proposed_by = auth.uid());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'bank_rule_change_decisions'
                 AND policyname = 'tenant_isolation') THEN
    CREATE POLICY tenant_isolation ON bank_rule_change_decisions
      TO app_user
      USING (company_id IN (SELECT auth.user_companies()))
      WITH CHECK (company_id = app.current_company_id() AND decided_by = auth.uid());
  END IF;
END $$;

-- Append-only by grant: every non-owner role loses everything, then app_user
-- gets SELECT and INSERT back (876's recipe).
DO $$
DECLARE r RECORD; t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['bank_rule_changes', 'bank_rule_change_decisions', 'bank_rule_change_states'] LOOP
    FOR r IN
      SELECT DISTINCT grantee FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND table_name = t
        AND grantee <> (SELECT pg_catalog.pg_get_userbyid(c.relowner) FROM pg_catalog.pg_class c
                        WHERE c.oid = pg_catalog.format('public.%I', t)::pg_catalog.regclass)
    LOOP
      EXECUTE pg_catalog.format('REVOKE ALL ON public.%I FROM %I', t, r.grantee);
    END LOOP;
    EXECUTE pg_catalog.format('REVOKE ALL ON public.%I FROM PUBLIC', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT ON bank_rule_changes TO app_user;
GRANT SELECT, INSERT ON bank_rule_change_decisions TO app_user;
GRANT SELECT ON bank_rule_change_states TO app_user;
DO $$
BEGIN
  EXECUTE pg_catalog.format('GRANT USAGE ON SEQUENCE %s TO app_user',
    pg_catalog.pg_get_serial_sequence('public.bank_rule_changes', 'seq'));
END $$;

-- The R-035 rank ladder (APPROVER_RANK in gl/approvalRank.ts, pinned equal by
-- bankRuleChangeCensus). NULL for a role not on it: a rule's unknown role
-- ranks as admin (requiredRank), a member's as nothing (actorRank).
CREATE OR REPLACE FUNCTION public.bank_control_rank(p_role pg_catalog.text) RETURNS pg_catalog.int4
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE p_role
    WHEN 'super_admin' THEN 8 WHEN 'owner' THEN 7 WHEN 'system' THEN 6 WHEN 'admin' THEN 5 WHEN 'manager' THEN 4
    WHEN 'accountant' THEN 3 WHEN 'bookkeeper' THEN 2 WHEN 'storeman' THEN 1 WHEN 'technician' THEN 1 WHEN 'user' THEN 1
    WHEN 'viewer' THEN 0 END
$$;

-- `p_user`'s rank in the company, -1 unless an active member in good standing.
-- Replaces 877's first bank_control_member_at_floor (the admin floor only).
DROP FUNCTION IF EXISTS public.bank_control_member_at_floor(pg_catalog.uuid, pg_catalog.text);
CREATE OR REPLACE FUNCTION public.bank_control_member_rank(p_company_id pg_catalog.uuid, p_user pg_catalog.text)
RETURNS pg_catalog.int4
LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT COALESCE((
    SELECT COALESCE(public.bank_control_rank(cu.role::pg_catalog.text), 0)
    FROM public.company_users cu JOIN public.users u ON u.id = cu.user_id
    WHERE cu.company_id = p_company_id AND cu.user_id = p_user
      AND u.is_active IS TRUE AND u.suspended_at IS NULL AND COALESCE(pg_catalog.lower(u.status), 'active') = 'active'), -1)
$$;

-- Who approves a held bank-rule change (bankRuleApproverRole): the strictest
-- ACTIVE manual_journal rule's role, never below admin — a rule only raises it.
CREATE OR REPLACE FUNCTION public.bank_rule_approver_role(p_company_id pg_catalog.uuid) RETURNS pg_catalog.text
LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT COALESCE((
    SELECT ar.approver_role FROM public.approval_rules ar
    WHERE ar.company_id = p_company_id AND ar.document_type = 'manual_journal' AND ar.is_active
      AND public.bank_control_rank(ar.approver_role) > public.bank_control_rank('admin')
    ORDER BY public.bank_control_rank(ar.approver_role) DESC LIMIT 1), 'admin')
$$;

-- R-035 Q2 on the admin floor: no OTHER active member of the company reaches
-- admin, judged on the roster snapshot (708's, via the SECURITY DEFINER
-- approval_company_other_members, which answers only for the caller's own
-- user and company).
CREATE OR REPLACE FUNCTION public.bank_control_sole_at_floor(p_roster pg_catalog.jsonb) RETURNS pg_catalog.bool
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_array_elements(COALESCE(p_roster -> 'others', '[]'::pg_catalog.jsonb)) e
    WHERE COALESCE(public.bank_control_rank(e ->> 'role'), 0) >= public.bank_control_rank('admin')
      AND (e ->> 'is_active') = 'true'
      AND COALESCE(e ->> 'suspended', 'false') = 'false'
      AND COALESCE(pg_catalog.lower(e ->> 'status'), 'active') = 'active')
$$;

-- The rule's current projection, in its company; NULL when there is none.
CREATE OR REPLACE FUNCTION public.bank_rule_current(p_company_id pg_catalog.uuid, p_rule_id pg_catalog.uuid)
RETURNS pg_catalog.jsonb
LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT public.bank_rule_projection(pg_catalog.to_jsonb(r))
  FROM public.bank_categorisation_rules r WHERE r.id = p_rule_id AND r.company_id = p_company_id
$$;

-- What a change row refuses, whoever writes it. SECURITY INVOKER: it reads as
-- the writer sees (app_user: its own tenant).
CREATE OR REPLACE FUNCTION public.bank_rule_change_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  shape pg_catalog.text[];
BEGIN
  NEW.proposed_at := pg_catalog.now();
  NEW.recorded_at := pg_catalog.clock_timestamp();
  NEW.seq := pg_catalog.nextval(pg_catalog.pg_get_serial_sequence('public.bank_rule_changes', 'seq'));
  IF NEW.status = 'applied' THEN
    -- An applied change is recorded only by the rules table's own trigger
    -- (bank_rule_history), as the write lands — never asserted by a caller.
    IF pg_catalog.pg_trigger_depth() < 2 THEN
      RAISE EXCEPTION 'bank_rule_changes: an applied change is recorded by the rules table itself, not inserted'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  -- A held change: only under the switch, only one that needs approval, and
  -- its `before` is the rule as it stands (the approval is judged against it).
  IF NOT EXISTS (SELECT 1 FROM public.approval_enforcement ae
                 WHERE ae.company_id = NEW.company_id AND ae.document_type = 'bank_rule') THEN
    RAISE EXCEPTION 'bank_rule_changes: bank rule approval is not enforced for this company' USING ERRCODE = '23514';
  END IF;
  IF NOT public.bank_rule_change_needs_approval(NEW.company_id, NEW.before, NEW.after) THEN
    RAISE EXCEPTION 'bank_rule_changes: this change does not need approval; apply it' USING ERRCODE = '23514';
  END IF;
  IF NEW.kind <> 'create' AND NEW.before IS DISTINCT FROM public.bank_rule_current(NEW.company_id, NEW.rule_id) THEN
    RAISE EXCEPTION 'bank_rule_changes: `before` is not rule %''s current state', NEW.rule_id USING ERRCODE = '23514';
  END IF;
  -- `after` is a whole rule: exactly the projection's keys, so applying it
  -- sets every column and nothing else.
  SELECT pg_catalog.array_agg(k ORDER BY k) INTO shape
    FROM pg_catalog.jsonb_object_keys(public.bank_rule_projection(
      pg_catalog.to_jsonb(pg_catalog.jsonb_populate_record(NULL::public.bank_categorisation_rules, '{}')))) k;
  IF pg_catalog.jsonb_typeof(NEW.after) <> 'object'
     OR (SELECT pg_catalog.array_agg(k ORDER BY k) FROM pg_catalog.jsonb_object_keys(NEW.after) k) IS DISTINCT FROM shape THEN
    RAISE EXCEPTION 'bank_rule_changes: `after` is not a whole rule' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS bank_rule_change_guard ON bank_rule_changes;
CREATE TRIGGER bank_rule_change_guard
  BEFORE INSERT ON bank_rule_changes
  FOR EACH ROW EXECUTE FUNCTION public.bank_rule_change_guard();

-- A newer change to a rule supersedes every undecided held change to it: the
-- held change's `before` is no longer the rule, so it could never apply.
CREATE OR REPLACE FUNCTION public.bank_rule_supersede_pending(p_company_id pg_catalog.uuid, p_rule_id pg_catalog.uuid,
  p_except pg_catalog.uuid) RETURNS void
LANGUAGE sql
SET search_path = pg_catalog, public, pg_temp
AS $$
  INSERT INTO public.bank_rule_change_decisions (company_id, change_id, decision, decided_by)
  SELECT c.company_id, c.id, 'superseded', COALESCE(auth.uid(), 'db:' || session_user)
  FROM public.bank_rule_changes c
  WHERE c.company_id = p_company_id AND c.rule_id = p_rule_id AND c.status = 'pending' AND c.id <> p_except
    AND NOT EXISTS (SELECT 1 FROM public.bank_rule_change_decisions d WHERE d.change_id = c.id)
  ORDER BY c.id
$$;

CREATE OR REPLACE FUNCTION public.bank_rule_change_after_insert() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.rule_id IS NOT NULL THEN
    PERFORM public.bank_rule_supersede_pending(NEW.company_id, NEW.rule_id, NEW.id);
  END IF;
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS bank_rule_change_after_insert ON bank_rule_changes;
CREATE TRIGGER bank_rule_change_after_insert
  AFTER INSERT ON bank_rule_changes
  FOR EACH ROW EXECUTE FUNCTION public.bank_rule_change_after_insert();

-- What a decision refuses, whoever writes it.
CREATE OR REPLACE FUNCTION public.bank_rule_decision_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  ch RECORD;
  required pg_catalog.text;
  own_rank pg_catalog.int4;
  only_proposer pg_catalog.bool;
BEGIN
  NEW.decided_at := pg_catalog.now();
  SELECT c.* INTO ch FROM public.bank_rule_changes c WHERE c.id = NEW.change_id AND c.company_id = NEW.company_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'bank_rule_change_decisions: change % not found in company %', NEW.change_id, NEW.company_id
      USING ERRCODE = '23503';
  END IF;
  IF ch.status <> 'pending' OR EXISTS (SELECT 1 FROM public.bank_rule_change_decisions d WHERE d.change_id = ch.id) THEN
    RAISE EXCEPTION 'bank_rule_change_decisions: change % is not awaiting a decision', ch.id USING ERRCODE = '23514';
  END IF;
  IF NEW.decision = 'superseded' THEN
    -- Only because another change to the same rule landed in this transaction.
    IF ch.rule_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.bank_rule_changes c2
      WHERE c2.company_id = ch.company_id AND c2.rule_id = ch.rule_id AND c2.id <> ch.id
        AND (c2.proposed_at = pg_catalog.now() OR EXISTS (
          SELECT 1 FROM public.bank_rule_change_decisions d2
          WHERE d2.change_id = c2.id AND d2.decision = 'approved' AND d2.decided_at = pg_catalog.now()))
    ) THEN
      RAISE EXCEPTION 'bank_rule_change_decisions: a change is superseded only by another change to its rule'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  -- Approve or reject: a person in good standing holding the approver role
  -- (bank_rule_approver_role, raised by a manual_journal rule) — or, when only
  -- the proposer holds a raised role, the admin floor (bankRuleApprovers.ts's
  -- fallback: otherwise the change could never be decided). The roster is
  -- approval_company_other_members, which answers only for the caller.
  required := public.bank_rule_approver_role(NEW.company_id);
  own_rank := public.bank_control_member_rank(NEW.company_id, NEW.decided_by);
  IF public.bank_control_rank(required) > public.bank_control_rank('admin') THEN
    WITH everyone AS (
      SELECT m.user_id, COALESCE(public.bank_control_rank(m.role), 0) AS rank
      FROM public.approval_company_other_members(NEW.company_id, NEW.decided_by) m
      WHERE m.is_active IS TRUE AND m.suspended_at IS NULL AND COALESCE(pg_catalog.lower(m.status), 'active') = 'active'
      UNION ALL SELECT NEW.decided_by, own_rank)
    SELECT NOT EXISTS (SELECT 1 FROM everyone e WHERE e.user_id <> ch.proposed_by AND e.rank >= public.bank_control_rank(required))
       AND EXISTS (SELECT 1 FROM everyone e WHERE e.user_id = ch.proposed_by AND e.rank >= public.bank_control_rank(required))
      INTO only_proposer;
    IF only_proposer THEN required := 'admin'; END IF;
  END IF;
  IF own_rank < public.bank_control_rank(required) THEN
    RAISE EXCEPTION 'bank_rule_change_decisions: % does not hold the % role or above, in good standing, in this company',
      NEW.decided_by, required USING ERRCODE = '23514';
  END IF;
  -- Not the proposer — except as the sole approver, recorded with the roster.
  IF NEW.decided_by = ch.proposed_by THEN
    IF NEW.roster_snapshot IS DISTINCT FROM public.approval_roster_snapshot(NEW.company_id, NEW.decided_by) THEN
      RAISE EXCEPTION 'bank_rule_change_decisions: the proposer of a change cannot decide it (roster_snapshot is not the company roster now)'
        USING ERRCODE = '23514';
    END IF;
    IF NOT public.bank_control_sole_at_floor(NEW.roster_snapshot) THEN
      RAISE EXCEPTION 'bank_rule_change_decisions: another active member could decide, so the proposer cannot'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.roster_snapshot IS NOT NULL THEN
    RAISE EXCEPTION 'bank_rule_change_decisions: a roster is recorded only for a sole approver' USING ERRCODE = '23514';
  END IF;
  IF NEW.decision = 'approved' THEN
    IF ch.kind = 'create' THEN
      IF NEW.rule_id IS NULL OR EXISTS (SELECT 1 FROM public.bank_categorisation_rules r WHERE r.id = NEW.rule_id) THEN
        RAISE EXCEPTION 'bank_rule_change_decisions: an approved creation names the new id of the rule it creates'
          USING ERRCODE = '23514';
      END IF;
    ELSE
      IF NEW.rule_id IS DISTINCT FROM ch.rule_id THEN
        RAISE EXCEPTION 'bank_rule_change_decisions: an approval names the rule its change is to' USING ERRCODE = '23514';
      END IF;
      -- Stale: the rule moved since the change was proposed.
      IF ch.before IS DISTINCT FROM public.bank_rule_current(ch.company_id, ch.rule_id) THEN
        RAISE EXCEPTION 'bank_rule_change_decisions: rule % changed since this change was proposed', ch.rule_id
          USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS bank_rule_decision_guard ON bank_rule_change_decisions;
CREATE TRIGGER bank_rule_decision_guard
  BEFORE INSERT ON bank_rule_change_decisions
  FOR EACH ROW EXECUTE FUNCTION public.bank_rule_decision_guard();

-- Approving one held change supersedes the others on its rule.
CREATE OR REPLACE FUNCTION public.bank_rule_decision_after_insert() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.decision = 'approved' THEN
    PERFORM public.bank_rule_supersede_pending(NEW.company_id, NEW.rule_id, NEW.change_id);
  END IF;
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS bank_rule_decision_after_insert ON bank_rule_change_decisions;
CREATE TRIGGER bank_rule_decision_after_insert
  AFTER INSERT ON bank_rule_change_decisions
  FOR EACH ROW EXECUTE FUNCTION public.bank_rule_decision_after_insert();

-- Append-only for every role, the owner included. The one exception is the
-- cascade from a purged company (876's recipe): by then the company row is gone.
CREATE OR REPLACE FUNCTION public.bank_rule_history_append_only() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  -- Nested, not AND: a TRUNCATE has no OLD row to read.
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM public.companies c WHERE c.id = OLD.company_id) THEN
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION '% is append-only (% refused)', TG_TABLE_NAME, TG_OP USING ERRCODE = '42501';
END
$$;

DROP TRIGGER IF EXISTS bank_rule_changes_append_only ON bank_rule_changes;
CREATE TRIGGER bank_rule_changes_append_only
  BEFORE UPDATE OR DELETE ON bank_rule_changes
  FOR EACH ROW EXECUTE FUNCTION public.bank_rule_history_append_only();
DROP TRIGGER IF EXISTS bank_rule_changes_no_truncate ON bank_rule_changes;
CREATE TRIGGER bank_rule_changes_no_truncate
  BEFORE TRUNCATE ON bank_rule_changes
  FOR EACH STATEMENT EXECUTE FUNCTION public.bank_rule_history_append_only();
DROP TRIGGER IF EXISTS bank_rule_change_decisions_append_only ON bank_rule_change_decisions;
CREATE TRIGGER bank_rule_change_decisions_append_only
  BEFORE UPDATE OR DELETE ON bank_rule_change_decisions
  FOR EACH ROW EXECUTE FUNCTION public.bank_rule_history_append_only();
DROP TRIGGER IF EXISTS bank_rule_change_decisions_no_truncate ON bank_rule_change_decisions;
CREATE TRIGGER bank_rule_change_decisions_no_truncate
  BEFORE TRUNCATE ON bank_rule_change_decisions
  FOR EACH STATEMENT EXECUTE FUNCTION public.bank_rule_history_append_only();

-- ── 4. The rules table: backstop and history ──────────────────────────────
-- A deleted supplier or GL account clears that one column on the rules naming
-- it. 489's composite FKs said plain SET NULL, which nulls company_id too: the
-- delete always failed (23502, and under 877 the guard's "company cannot
-- change"). PostgreSQL 15+ narrows the action to the column. Before such a
-- delete the application disables the rules that post money through it
-- (bankRuleChangeControl.disableRulesLosingTarget): losing where a rule posts
-- re-points it, which the guard below holds for approval.
DO $$
BEGIN
  IF pg_catalog.current_setting('server_version_num')::pg_catalog.int4 >= 150000 THEN
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'bank_categorisation_rules_supplier_tenant_fkey'
               AND conrelid = 'public.bank_categorisation_rules'::pg_catalog.regclass AND confdelsetcols IS NULL) THEN
      ALTER TABLE bank_categorisation_rules DROP CONSTRAINT bank_categorisation_rules_supplier_tenant_fkey;
      ALTER TABLE bank_categorisation_rules ADD CONSTRAINT bank_categorisation_rules_supplier_tenant_fkey
        FOREIGN KEY (supplier_id, company_id) REFERENCES suppliers(id, company_id) ON DELETE SET NULL (supplier_id) DEFERRABLE;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'bank_categorisation_rules_gl_account_tenant_fkey'
               AND conrelid = 'public.bank_categorisation_rules'::pg_catalog.regclass AND confdelsetcols IS NULL) THEN
      ALTER TABLE bank_categorisation_rules DROP CONSTRAINT bank_categorisation_rules_gl_account_tenant_fkey;
      ALTER TABLE bank_categorisation_rules ADD CONSTRAINT bank_categorisation_rules_gl_account_tenant_fkey
        FOREIGN KEY (gl_account_id, company_id) REFERENCES gl_accounts(id, company_id) ON DELETE SET NULL (gl_account_id) DEFERRABLE;
    END IF;
  END IF;
END $$;

-- Whether this transaction approved the change that turns rule p_rule_id into
-- p_after: the one way a gated write passes.
CREATE OR REPLACE FUNCTION public.bank_rule_write_approved(p_company_id pg_catalog.uuid, p_rule_id pg_catalog.uuid,
  p_after pg_catalog.jsonb) RETURNS pg_catalog.bool
LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.bank_rule_change_decisions d
    JOIN public.bank_rule_changes c ON c.id = d.change_id AND c.company_id = d.company_id
    WHERE d.company_id = p_company_id AND d.rule_id = p_rule_id AND d.decision = 'approved'
      AND d.decided_at = pg_catalog.now() AND c.after = p_after)
$$;

-- BEFORE INSERT OR UPDATE: under the switch, a write needing approval lands
-- only as the application of a change approved in this transaction.
CREATE OR REPLACE FUNCTION public.bank_rule_write_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  after_p pg_catalog.jsonb := public.bank_rule_projection(pg_catalog.to_jsonb(NEW));
  before_p pg_catalog.jsonb;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.company_id IS DISTINCT FROM OLD.company_id THEN
      RAISE EXCEPTION 'bank_categorisation_rules: a rule''s id and company cannot change' USING ERRCODE = '42501';
    END IF;
    before_p := public.bank_rule_projection(pg_catalog.to_jsonb(OLD));
  END IF;
  IF public.bank_rule_change_needs_approval(NEW.company_id, before_p, after_p)
     AND EXISTS (SELECT 1 FROM public.approval_enforcement ae
                 WHERE ae.company_id = NEW.company_id AND ae.document_type = 'bank_rule')
     AND NOT public.bank_rule_write_approved(NEW.company_id, NEW.id, after_p) THEN
    RAISE EXCEPTION 'bank_categorisation_rules: this change makes rule % post money unattended and needs another person''s approval',
      NEW.id USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS bank_rule_write_guard ON bank_categorisation_rules;
CREATE TRIGGER bank_rule_write_guard
  BEFORE INSERT OR UPDATE ON bank_categorisation_rules
  FOR EACH ROW EXECUTE FUNCTION public.bank_rule_write_guard();

-- AFTER every write: one history row, always — whoever wrote it. The kind is
-- the operation's, or a declared 'seed' (an INSERT) / 'merge' (an UPDATE)
-- from the transaction-local isaflow.bank_rule_change_kind. A write that
-- changes nothing in the projection (updated_at, a no-op) records nothing;
-- the application of an approved change is recorded by that change and its
-- decision.
CREATE OR REPLACE FUNCTION public.bank_rule_history() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  before_p pg_catalog.jsonb;
  after_p pg_catalog.jsonb;
  rule_row RECORD;
  declared pg_catalog.text := NULLIF(pg_catalog.current_setting('isaflow.bank_rule_change_kind', true), '');
  kind pg_catalog.text;
BEGIN
  IF TG_OP <> 'INSERT' THEN before_p := public.bank_rule_projection(pg_catalog.to_jsonb(OLD)); END IF;
  IF TG_OP <> 'DELETE' THEN after_p := public.bank_rule_projection(pg_catalog.to_jsonb(NEW)); END IF;
  IF TG_OP = 'DELETE' THEN rule_row := OLD; ELSE rule_row := NEW; END IF;
  IF TG_OP = 'UPDATE' AND before_p = after_p THEN RETURN NULL; END IF;
  IF after_p IS NOT NULL AND public.bank_rule_write_approved(rule_row.company_id, rule_row.id, after_p) THEN
    RETURN NULL;
  END IF;
  kind := CASE TG_OP
    WHEN 'INSERT' THEN CASE WHEN declared = 'seed' THEN 'seed' ELSE 'create' END
    WHEN 'DELETE' THEN 'delete'
    ELSE CASE WHEN declared = 'merge' THEN 'merge'
              WHEN (before_p - 'is_active') = (after_p - 'is_active') THEN 'toggle'
              ELSE 'update' END
  END;
  INSERT INTO public.bank_rule_changes (company_id, rule_id, kind, before, after, proposed_by, status)
  VALUES (rule_row.company_id, rule_row.id, kind, before_p, after_p, COALESCE(auth.uid(), 'db:' || session_user), 'applied');
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS bank_rule_history ON bank_categorisation_rules;
CREATE TRIGGER bank_rule_history
  AFTER INSERT OR UPDATE OR DELETE ON bank_categorisation_rules
  FOR EACH ROW EXECUTE FUNCTION public.bank_rule_history();

-- Applies an approved change: its decision must already be in this
-- transaction (the write guard accepts nothing else). Columns come from the
-- change's `after`, every one by name, so a column added later is applied too.
CREATE OR REPLACE FUNCTION public.bank_rule_change_apply(p_company_id pg_catalog.uuid, p_change_id pg_catalog.uuid)
RETURNS pg_catalog.uuid
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  ch RECORD;
  d RECORD;
  cols pg_catalog.text;
BEGIN
  SELECT c.* INTO ch FROM public.bank_rule_changes c WHERE c.id = p_change_id AND c.company_id = p_company_id;
  SELECT x.* INTO d FROM public.bank_rule_change_decisions x
   WHERE x.change_id = p_change_id AND x.company_id = p_company_id AND x.decision = 'approved'
     AND x.decided_at = pg_catalog.now();
  IF ch.id IS NULL OR d.id IS NULL THEN
    RAISE EXCEPTION 'bank_rule_change_apply: change % was not approved in this transaction', p_change_id
      USING ERRCODE = '23514';
  END IF;
  IF ch.kind = 'create' THEN
    INSERT INTO public.bank_categorisation_rules
    SELECT (pg_catalog.jsonb_populate_record(NULL::public.bank_categorisation_rules,
      ch.after || pg_catalog.jsonb_build_object('id', d.rule_id, 'company_id', ch.company_id, 'created_by', ch.proposed_by,
                                                'created_at', pg_catalog.now(), 'updated_at', pg_catalog.now()))).*;
  ELSE
    SELECT pg_catalog.string_agg(pg_catalog.format('%I = n.%I', k, k), ', ' ORDER BY k) INTO cols
      FROM pg_catalog.jsonb_object_keys(ch.after) k;
    EXECUTE pg_catalog.format(
      'UPDATE public.bank_categorisation_rules r SET %s, updated_at = pg_catalog.now()
         FROM pg_catalog.jsonb_populate_record(NULL::public.bank_categorisation_rules, $1) n
        WHERE r.id = $2 AND r.company_id = $3', cols)
      USING ch.after, d.rule_id, ch.company_id;
  END IF;
  RETURN d.rule_id;
END
$$;

-- ── 4b. Switching auto-post on (breaker round 2, R2-2b) ───────────────────
-- With auto-post off a suggest-only rule posts nothing, so changing it needs
-- nobody; switching auto-post back on would then make every such change post
-- money without a second person ever seeing it. So switching it on is refused
-- (autoPostSettingsService) while an ACTIVE rule differs from its state at the
-- CUTOFF in a way that would have needed approval had auto-post been on, and
-- someone other than the person switching it on made a change in between
-- that nobody approved.
--
-- The cutoff is the later of when `bank_rule` was switched on and when
-- auto-post was last switched OFF. Changes are placed by recorded_at (R3-1).
-- bank_rule's enabled_at is its transaction's start (the column default), and
-- switching it on takes bankRuleAutoPostLock exclusively: a rule change
-- recorded after that start is counted even if its own transaction began
-- earlier, and one recorded before it was made before the switch existed. That second time is kept by the table
-- itself: bank_auto_post_settings.disabled_at, set only by this trigger, only
-- on an on→off transition (a fresh row records none, so deleting and
-- re-inserting the row can only move the cutoff EARLIER). The settings audit
-- rows are not used: app_user can write those (the N1 boundary).
ALTER TABLE bank_auto_post_settings ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION public.bank_auto_post_disabled_at() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.disabled_at := NULL;
  ELSIF OLD.enabled AND NOT NEW.enabled THEN
    -- clock_timestamp(), not now(): the switch-off holds bankRuleAutoPostLock
    -- exclusively by this point, so this is after every rule change that held
    -- the shared lock first (each classified with auto-post still on: held if
    -- it needed approval) and before every one that waits (recorded later).
    -- now() — this transaction's start — could precede a change recorded while
    -- this one waited for the lock; same clock as recorded_at (R3-1).
    NEW.disabled_at := pg_catalog.clock_timestamp();
  ELSE
    NEW.disabled_at := OLD.disabled_at;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS bank_auto_post_disabled_at ON bank_auto_post_settings;
CREATE TRIGGER bank_auto_post_disabled_at
  BEFORE INSERT OR UPDATE ON bank_auto_post_settings
  FOR EACH ROW EXECUTE FUNCTION public.bank_auto_post_disabled_at();

CREATE OR REPLACE FUNCTION public.bank_rule_auto_post_cutoff(p_company_id pg_catalog.uuid) RETURNS pg_catalog.timestamptz
LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT GREATEST(ae.enabled_at,
           (SELECT s.disabled_at FROM public.bank_auto_post_settings s WHERE s.company_id = p_company_id))
  FROM public.approval_enforcement ae WHERE ae.company_id = p_company_id AND ae.document_type = 'bank_rule'
$$;

-- The active rules that block switching auto-post on for `p_enabler`. A
-- rule's state at the cutoff is the `after` of the last change that landed
-- before it — else the `before` of the first after it (a rule older than its
-- history) — else nothing (created since: a re-created rule is a creation).
-- The whole span is judged, not the latest change, so a re-point followed by
-- a rename still counts. Changes that landed: `applied` at proposed_at,
-- `approved` at decided_at; only `applied` ones are unreviewed.
CREATE OR REPLACE FUNCTION public.bank_rule_unreviewed_changes(p_company_id pg_catalog.uuid, p_enabler pg_catalog.text)
RETURNS TABLE (rule_id pg_catalog.uuid, rule_name pg_catalog.text, changed_by pg_catalog.text[], last_changed_at pg_catalog.timestamptz)
LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  WITH cutoff AS (SELECT public.bank_rule_auto_post_cutoff(p_company_id) AS t),
  landed AS (
    SELECT s.rule_id, s.seq, s.before, s.after, s.status, s.proposed_by,
           CASE WHEN s.status = 'approved' THEN s.decided_at ELSE COALESCE(s.recorded_at, s.proposed_at) END AS at
    FROM public.bank_rule_change_states s
    WHERE s.company_id = p_company_id AND s.status IN ('applied', 'approved'))
  SELECT r.id, r.rule_name::pg_catalog.text, x.who, x.last_at
  FROM public.bank_categorisation_rules r
  CROSS JOIN cutoff
  CROSS JOIN LATERAL (
    SELECT COALESCE(
      (SELECT l.after FROM landed l WHERE l.rule_id = r.id AND l.at < cutoff.t ORDER BY l.at DESC, l.seq DESC LIMIT 1),
      (SELECT l.before FROM landed l WHERE l.rule_id = r.id AND l.at >= cutoff.t ORDER BY l.at, l.seq LIMIT 1)) AS p) b
  CROSS JOIN LATERAL (
    SELECT pg_catalog.array_agg(DISTINCT l.proposed_by ORDER BY l.proposed_by) AS who, pg_catalog.max(l.at) AS last_at
    FROM landed l
    WHERE l.rule_id = r.id AND l.at >= cutoff.t AND l.status = 'applied' AND l.proposed_by IS DISTINCT FROM p_enabler) x
  WHERE r.company_id = p_company_id AND r.is_active AND cutoff.t IS NOT NULL AND x.who IS NOT NULL
    AND public.bank_rule_change_needs_approval(p_company_id, b.p, public.bank_rule_projection(pg_catalog.to_jsonb(r)), true)
  ORDER BY r.rule_name, r.id
$$;

-- ── 5. The switch ─────────────────────────────────────────────────────────
-- 876's list verbatim, plus the new type. Like supplier_bank_details it
-- governs no approval_rules row: who approves follows the manual-journal rules.
ALTER TABLE approval_enforcement DROP CONSTRAINT IF EXISTS approval_enforcement_document_type_check;
ALTER TABLE approval_enforcement ADD CONSTRAINT approval_enforcement_document_type_check CHECK (document_type IN (
  'customer_invoice', 'supplier_invoice', 'payment', 'journal_entry', 'credit_note',
  'customer_credit_note', 'supplier_credit_note', 'supplier_payment', 'payment_batch', 'manual_journal',
  'supplier_bank_details', 'bank_rule'));
