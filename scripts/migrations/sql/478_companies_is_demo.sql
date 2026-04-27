-- Migration 478: Add is_demo flag to companies table
-- Demo tenants (e.g. ISAFlow Demo) are marked is_demo=true so the UI can
-- display a persistent warning banner reminding reviewers that dates and
-- balances are simulated. All production companies default to false.
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT false;
