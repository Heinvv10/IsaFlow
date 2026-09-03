-- Migration 581: which firm the actor was acting FOR
--
-- The fourth attribution axis. A journal posted by a practice into a client's
-- books must be attributable to the firm, to the client company, and to the
-- person — firms do not post journals, people do. Three of those four axes
-- already exist and audit_trail already reports them:
--
--   whose books      company_id                      (always present)
--   which human      created_by / posted_by          (uuid, since inception)
--   agent | human    actor_type / actor_token_jti    (migration 530/531)
--   WHICH FIRM       acting_company_id               (this migration)
--
-- acting_company_id is the company the actor was operating FROM. It is NULL
-- for ordinary in-house work, where it would equal company_id.
--
-- READING A NULL IS THE THING TO GET RIGHT.
--   NULL means UNKNOWN, not "same company".
--   Every row written before this migration has NULL, and so does every row
--   written after it until the multi-company amendment gives a token a firm to
--   record. audit_trail therefore reports NULL as unknown and never resolves
--   it to company_id — the identical discipline actor_type is under, and for
--   the identical reason: an audit trail that presents an inference as a fact
--   is worse than one that admits the gap, because a reader cannot tell which
--   rows to go and check by hand. If a future version ever DOES derive the
--   firm, it must be reported with a provenance and a caveat like actor_type.
--
-- NO BACKFILL. Not one existing row is touched. See 530's note.
--
-- ALL FOUR DOCUMENT TABLES, the same set as 530/531 and for the same reason:
-- create_credit_note and the draft-invoice paths write a document row and no
-- journal until approval, so during the whole draft period the document row is
-- the only place the actor can be recorded. A practice raising a draft into a
-- client's books is exactly the case this axis exists for.
--
-- TYPE uuid, matching companies.id. NO FOREIGN KEY — consistent with 530/531
-- and with company_groups.created_by / intercompany_eliminations.created_by.
-- companies.id is genuinely uuid so an FK would apply cleanly here, unlike the
-- actor/user columns where users.id is character varying(255); it is omitted
-- because validating one on gl_journal_entries takes a lock on the largest
-- table in the system to enforce something the application already does.
--
-- LOCK SAFETY, stated because the next person copies this file: the columns
-- are added in this same migration, so they are NULL on every existing row and
-- the index builds below scan nothing. That is a property of the data at this
-- moment, NOT of the statements. The same CREATE INDEX against a populated
-- column takes an ACCESS EXCLUSIVE lock for a full scan, which on
-- gl_journal_entries means every posting blocks. If you are copying this,
-- use CREATE INDEX CONCURRENTLY outside a transaction. See 531's header.

ALTER TABLE gl_journal_entries ADD COLUMN IF NOT EXISTS acting_company_id UUID;
ALTER TABLE customer_invoices  ADD COLUMN IF NOT EXISTS acting_company_id UUID;
ALTER TABLE supplier_invoices  ADD COLUMN IF NOT EXISTS acting_company_id UUID;
ALTER TABLE credit_notes       ADD COLUMN IF NOT EXISTS acting_company_id UUID;

-- "Everything posted into this company by someone outside it" — the first
-- question a client's auditor asks of a practice engagement. PARTIAL, because
-- the column is NULL on in-house work, which is nearly every row: indexing
-- those nulls costs space to serve no query. Leads with company_id, like every
-- other index here: every query in this system is tenant-scoped and an index
-- that does not lead with the tenant is not used by them.
CREATE INDEX IF NOT EXISTS idx_gl_journal_entries_acting_company
  ON gl_journal_entries (company_id, acting_company_id, entry_date)
  WHERE acting_company_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_customer_invoices_acting_company
  ON customer_invoices (company_id, acting_company_id)
  WHERE acting_company_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_supplier_invoices_acting_company
  ON supplier_invoices (company_id, acting_company_id)
  WHERE acting_company_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_credit_notes_acting_company
  ON credit_notes (company_id, acting_company_id)
  WHERE acting_company_id IS NOT NULL;

COMMENT ON COLUMN gl_journal_entries.acting_company_id IS
  'The company the actor was operating FROM — the practice, on a client engagement. NULL means UNKNOWN, never "same company": it is NULL on every row written before migration 581 and on every row until a token carries a firm binding. Never resolve it to company_id at read time.';
COMMENT ON COLUMN customer_invoices.acting_company_id IS
  'See gl_journal_entries.acting_company_id. Recorded on the document because a draft posts no journal until approval.';
COMMENT ON COLUMN supplier_invoices.acting_company_id IS
  'See gl_journal_entries.acting_company_id. Recorded on the document because a draft posts no journal until approval.';
COMMENT ON COLUMN credit_notes.acting_company_id IS
  'See gl_journal_entries.acting_company_id. Recorded on the document because a draft posts no journal until approval.';
