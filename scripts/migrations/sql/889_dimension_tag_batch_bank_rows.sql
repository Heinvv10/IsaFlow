-- 889: Bank rows a dimension tag batch touched (write-through of journal tags).
--
-- A bank transaction's own cc1_id / cc2_id / bu_id are what the Banking screen
-- shows, but the dimension back-tag (tag_journal_lines) writes the POSTED
-- journal lines — the source the P&L, the GL-line export and the R0.00 proof
-- read. Nothing carried the journal's tags back to the bank row, so the screen
-- showed blank columns over tagged books (Hein, 12 Oct 2026).
--
-- From now on a tag batch also mirrors the journal's tags onto the bank row
-- allocated to that journal (only when the journal's dimension lines agree on
-- one CC1/CC2/BU set; NULLs are copied too), and sync_bank_dimensions back-fills
-- the rows tagged before this. Each bank row changed is recorded here with its
-- OLD and NEW values, so reverse_dimension_tag_batch restores the bank row
-- together with the lines.
--
-- A sync_bank_dimensions batch has no lines, so it is recognised by the date
-- window it ran over (sync_date_from / sync_date_to, both or neither): an
-- idempotency key that already names a batch of the other kind, or a sync of
-- another window, is refused rather than replayed.
--
-- Same shape, RLS and grants as dimension_tag_batch_lines (870).
-- Rollback: DROP TABLE dimension_tag_batch_bank_rows; and drop the two sync_*
-- columns (bank rows keep whatever dimensions they were given — reverse the
-- batches first if that matters).

ALTER TABLE dimension_tag_batches ADD COLUMN IF NOT EXISTS sync_date_from DATE;
ALTER TABLE dimension_tag_batches ADD COLUMN IF NOT EXISTS sync_date_to DATE;
ALTER TABLE dimension_tag_batches DROP CONSTRAINT IF EXISTS dimension_tag_batches_sync_window_chk;
ALTER TABLE dimension_tag_batches ADD CONSTRAINT dimension_tag_batches_sync_window_chk
  CHECK ((sync_date_from IS NULL) = (sync_date_to IS NULL));

CREATE TABLE IF NOT EXISTS dimension_tag_batch_bank_rows (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id            UUID NOT NULL REFERENCES dimension_tag_batches(id) ON DELETE CASCADE,
  company_id          UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  bank_transaction_id UUID NOT NULL REFERENCES bank_transactions(id) ON DELETE CASCADE,
  old_cc1_id          UUID,
  old_cc2_id          UUID,
  old_bu_id           UUID,
  new_cc1_id          UUID,
  new_cc2_id          UUID,
  new_bu_id           UUID
);
CREATE INDEX IF NOT EXISTS idx_dimension_tag_batch_bank_rows_batch ON dimension_tag_batch_bank_rows(batch_id);
CREATE INDEX IF NOT EXISTS idx_dimension_tag_batch_bank_rows_tx ON dimension_tag_batch_bank_rows(bank_transaction_id);

ALTER TABLE dimension_tag_batch_bank_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE dimension_tag_batch_bank_rows FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON dimension_tag_batch_bank_rows TO app_user, platform_admin;
GRANT ALL ON dimension_tag_batch_bank_rows TO migration_admin;

DROP POLICY IF EXISTS tenant_isolation ON dimension_tag_batch_bank_rows;
CREATE POLICY tenant_isolation ON dimension_tag_batch_bank_rows
  FOR ALL TO app_user
  USING (company_id IN (SELECT auth.user_companies()))
  WITH CHECK (company_id IN (SELECT auth.user_companies()) AND company_id = app.current_company_id());
