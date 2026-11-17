-- Migration 999j: the journal an auto-post run (or a bulk accept) posted for a bank line (WP6 review F1).
--
-- bank_transactions.auto_post_run_id says which run tagged a line; it does not say WHICH POSTING the run made. A line a
-- person reversed and re-allocated by hand kept the tag, and undoing the run reversed the person's own re-coding. The run
-- now records the journal it posted here, and the undo reverses a line only while its current posting is that journal.
-- NULL on every line written before this migration (and on lines no run touched): the undo then judges by the tag alone,
-- as before. A hand reverse or allocation clears both columns together.
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS auto_post_journal_id uuid;
COMMENT ON COLUMN bank_transactions.auto_post_journal_id IS
  'The journal the line''s auto_post_run_id run posted for it. A run''s undo reverses the line only while its current posting is this journal.';
