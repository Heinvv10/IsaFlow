-- Migration 473: Drop user_preferences -> users FK
--
-- The FK fails for any authenticated user whose JWT sub does not have a
-- matching row in public.users (admin-created GoTrue users, demo seed
-- users, OAuth signups, etc.). user_preferences is a non-critical per-user
-- KV store keyed by JWT sub; the JWT itself is the source of truth for
-- user identity, and other auth-adjacent tables (company_users) already
-- omit the FK for the same reason.
--
-- Audit: docs/codex/browser-audits/monthly-close-market-readiness-audit.md
-- Finding 1 — PUT /api/auth/preferences 500 on user_preferences_user_id_fkey.

ALTER TABLE user_preferences
  DROP CONSTRAINT IF EXISTS user_preferences_user_id_fkey;
