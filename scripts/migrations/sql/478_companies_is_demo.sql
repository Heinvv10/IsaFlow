-- Migration 478: Add is_demo flag to companies table.
-- Allows explicit tagging of demo tenants without relying on name matching.
-- Post-merge manual step (do NOT run automatically):
--   UPDATE companies SET is_demo = true WHERE name = 'ISAFlow Demo';

ALTER TABLE companies ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT false;
