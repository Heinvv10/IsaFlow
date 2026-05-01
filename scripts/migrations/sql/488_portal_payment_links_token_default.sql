-- Hotfix: restore the DEFAULT on portal_payment_links.token.
--
-- Migration 235 declared the column with a default
-- (`encode(gen_random_bytes(32), 'hex')`), but the live prod schema lacks
-- it — likely because 235 was a no-op (`CREATE TABLE IF NOT EXISTS`) on a
-- DB where the table already existed without the default. Without the
-- default, the "Enable online payment" flow fails:
--   null value in column "token" of relation "portal_payment_links"
--   violates not-null constraint
-- The portal service inserts without supplying a token and relies on the
-- default. This migration is idempotent — re-runs are no-ops.

ALTER TABLE portal_payment_links
  ALTER COLUMN token SET DEFAULT encode(gen_random_bytes(32), 'hex');
