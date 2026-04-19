-- 376_time_entries_write_off.sql
-- Track the reason an entry was written off (status='not_billable').

ALTER TABLE time_entries
  ADD COLUMN IF NOT EXISTS write_off_reason TEXT,
  ADD COLUMN IF NOT EXISTS written_off_by   UUID,
  ADD COLUMN IF NOT EXISTS written_off_at   TIMESTAMPTZ;
