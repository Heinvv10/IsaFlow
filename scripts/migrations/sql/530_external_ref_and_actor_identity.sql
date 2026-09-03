-- Migration 530: source-system identity on documents, actor identity on writes
--
-- Two findings from the 2026-09-03 MCP endpoint audit, both of which are
-- schema gaps rather than code defects, and both of which every workstream in
-- the assurance programme depends on.
--
-- 1. EXTERNAL REFERENCES.
--    On the Sage migration, invoice INV0000133 became IsaFlow INV0000137,
--    because IsaFlow assigns its own document numbers and refuses a supplied
--    one. Both numbers exist, they refer to the same sale, and nothing in
--    either system records that they are the same sale. The crosswalk is not
--    merely lost — it cannot be rebuilt, because the only shared key was the
--    number that got overwritten. Every future reconciliation against the
--    legacy books mismatches, permanently.
--
--    The fix is not to let callers set the document number: IsaFlow's own
--    sequence is what makes the numbering auditable, and a caller-supplied
--    number puts a gap in it. It is to store the origin ALONGSIDE it.
--
--    Three columns, on every table that holds a document a migration can
--    create:
--      external_ref              the source system's own primary key. Survives
--                                a renumbering in the source system, which the
--                                displayed number does not.
--      external_document_number  the number the source system showed a human.
--                                This is what someone holding the old
--                                paperwork will search for.
--      external_system           'sage' | 'xero' | 'quickbooks' | 'csv_import'.
--
--    INDEXED, because a reference you cannot query by is a comment. The
--    indexes lead with company_id: every query in this system is tenant-scoped
--    and an index that does not lead with the tenant is not used by them.
--    They are PARTIAL — the columns are null on everything IsaFlow originated,
--    which is nearly every row, and indexing those nulls costs space to serve
--    no query.
--
--    NOT unique. Two source systems can legitimately issue the same reference,
--    a re-import of a corrected statement can carry references already present,
--    and a uniqueness violation discovered mid-import aborts a migration that
--    was otherwise fine. Duplicate detection belongs in the integrity checks
--    (Tier 4), where it reports rather than refuses.
--
-- 2. ACTOR IDENTITY.
--    4,300 programmatic postings on Brightsphere are attributed to "Hein van
--    Vuuren" and cannot be told apart from entries someone typed. For an
--    accounting system that is an assurance failure, not a logging gap: an
--    auditor cannot form a view on controls over a ledger that cannot say who
--    posted to it, and "an agent posted this" is a different control
--    conclusion from "a director posted this" even when the journal is
--    identical.
--
--    gl_journal_entries.posting_agent already carries an 'mcp:<tool>:v1' stamp
--    and does distinguish agent from human. What it cannot do is say WHICH
--    TOKEN: two agents on one company are indistinguishable, and the postings
--    made by a token that has since been revoked cannot be listed — which is
--    the first question asked after a credential is withdrawn.
--
--    actor_type is TEXT with a CHECK rather than an enum type. Widening it is
--    then an ALTER of one constraint; widening an enum is ALTER TYPE ADD VALUE,
--    whose transactional behaviour is version-dependent and which rewrites
--    dependent objects on a table holding every journal line in the system.
--
-- NO BACKFILL, DELIBERATELY.
--    Not one existing row is touched. actor_type is NULL on everything written
--    before this migration, and the audit_trail endpoint (W5) derives the
--    actor of a legacy row from posting_agent at READ time —
--    posting_agent LIKE 'mcp:%' means agent, 'human:%' means human — rather
--    than writing a guess into the ledger. A derived value can be corrected
--    when the derivation turns out to be wrong; a backfilled one cannot be
--    told from a recorded one afterwards, which is the property that makes an
--    audit trail worth having. It also keeps this migration inside the
--    programme's standing rule: build the endpoint that FINDS the problem;
--    correcting data is a separate decision with its own approval.

-- ---------------------------------------------------------------------------
-- 1. External references
-- ---------------------------------------------------------------------------

ALTER TABLE customer_invoices  ADD COLUMN IF NOT EXISTS external_ref TEXT;
ALTER TABLE customer_invoices  ADD COLUMN IF NOT EXISTS external_document_number TEXT;
ALTER TABLE customer_invoices  ADD COLUMN IF NOT EXISTS external_system TEXT;

ALTER TABLE supplier_invoices  ADD COLUMN IF NOT EXISTS external_ref TEXT;
ALTER TABLE supplier_invoices  ADD COLUMN IF NOT EXISTS external_document_number TEXT;
ALTER TABLE supplier_invoices  ADD COLUMN IF NOT EXISTS external_system TEXT;

ALTER TABLE credit_notes       ADD COLUMN IF NOT EXISTS external_ref TEXT;
ALTER TABLE credit_notes       ADD COLUMN IF NOT EXISTS external_document_number TEXT;
ALTER TABLE credit_notes       ADD COLUMN IF NOT EXISTS external_system TEXT;

ALTER TABLE gl_journal_entries ADD COLUMN IF NOT EXISTS external_ref TEXT;
ALTER TABLE gl_journal_entries ADD COLUMN IF NOT EXISTS external_document_number TEXT;
ALTER TABLE gl_journal_entries ADD COLUMN IF NOT EXISTS external_system TEXT;

ALTER TABLE bank_transactions  ADD COLUMN IF NOT EXISTS external_ref TEXT;
ALTER TABLE bank_transactions  ADD COLUMN IF NOT EXISTS external_document_number TEXT;
ALTER TABLE bank_transactions  ADD COLUMN IF NOT EXISTS external_system TEXT;

-- The parties, so a migrated invoice's customer is traceable too. Half the
-- Sage crosswalk broke at the party, not at the document: you cannot create a
-- customer over the API, so a migration has a manual step in the middle.
ALTER TABLE customers          ADD COLUMN IF NOT EXISTS external_ref TEXT;
ALTER TABLE customers          ADD COLUMN IF NOT EXISTS external_document_number TEXT;
ALTER TABLE customers          ADD COLUMN IF NOT EXISTS external_system TEXT;

ALTER TABLE suppliers          ADD COLUMN IF NOT EXISTS external_ref TEXT;
ALTER TABLE suppliers          ADD COLUMN IF NOT EXISTS external_document_number TEXT;
ALTER TABLE suppliers          ADD COLUMN IF NOT EXISTS external_system TEXT;

CREATE INDEX IF NOT EXISTS idx_customer_invoices_external_ref
  ON customer_invoices (company_id, external_ref) WHERE external_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_customer_invoices_external_doc_number
  ON customer_invoices (company_id, external_document_number) WHERE external_document_number IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_supplier_invoices_external_ref
  ON supplier_invoices (company_id, external_ref) WHERE external_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_supplier_invoices_external_doc_number
  ON supplier_invoices (company_id, external_document_number) WHERE external_document_number IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_credit_notes_external_ref
  ON credit_notes (company_id, external_ref) WHERE external_ref IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_gl_journal_entries_external_ref
  ON gl_journal_entries (company_id, external_ref) WHERE external_ref IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_bank_transactions_external_ref
  ON bank_transactions (company_id, external_ref) WHERE external_ref IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_customers_external_ref
  ON customers (company_id, external_ref) WHERE external_ref IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_suppliers_external_ref
  ON suppliers (company_id, external_ref) WHERE external_ref IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. Actor identity
-- ---------------------------------------------------------------------------

ALTER TABLE gl_journal_entries ADD COLUMN IF NOT EXISTS actor_type TEXT;
ALTER TABLE gl_journal_entries ADD COLUMN IF NOT EXISTS actor_token_jti TEXT;

ALTER TABLE supplier_invoices  ADD COLUMN IF NOT EXISTS actor_type TEXT;
ALTER TABLE supplier_invoices  ADD COLUMN IF NOT EXISTS actor_token_jti TEXT;

ALTER TABLE customer_invoices  ADD COLUMN IF NOT EXISTS actor_type TEXT;
ALTER TABLE customer_invoices  ADD COLUMN IF NOT EXISTS actor_token_jti TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_gl_je_actor_type'
  ) THEN
    ALTER TABLE gl_journal_entries
      ADD CONSTRAINT chk_gl_je_actor_type
      CHECK (actor_type IS NULL OR actor_type IN ('human', 'agent', 'system'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_supplier_invoices_actor_type'
  ) THEN
    ALTER TABLE supplier_invoices
      ADD CONSTRAINT chk_supplier_invoices_actor_type
      CHECK (actor_type IS NULL OR actor_type IN ('human', 'agent', 'system'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_customer_invoices_actor_type'
  ) THEN
    ALTER TABLE customer_invoices
      ADD CONSTRAINT chk_customer_invoices_actor_type
      CHECK (actor_type IS NULL OR actor_type IN ('human', 'agent', 'system'));
  END IF;
END $$;

-- Lists every posting made by one token. The first question after a credential
-- is withdrawn, and unanswerable today.
CREATE INDEX IF NOT EXISTS idx_gl_journal_entries_actor_token
  ON gl_journal_entries (company_id, actor_token_jti) WHERE actor_token_jti IS NOT NULL;

-- Separates agent from human over a date range — the audit_trail endpoint's
-- main query. Partial, because legacy rows carry NULL and are resolved from
-- posting_agent instead.
CREATE INDEX IF NOT EXISTS idx_gl_journal_entries_actor_type_date
  ON gl_journal_entries (company_id, actor_type, entry_date) WHERE actor_type IS NOT NULL;

COMMENT ON COLUMN gl_journal_entries.actor_type IS
  'human | agent | system. NULL on rows written before migration 530 — derive those from posting_agent at read time, never backfill.';
COMMENT ON COLUMN gl_journal_entries.actor_token_jti IS
  'PAT id or OAuth authorisation id that made this posting. NULL for human and system writes.';
COMMENT ON COLUMN gl_journal_entries.external_ref IS
  'Source system primary key for a migrated record. IsaFlow still assigns its own entry number.';
