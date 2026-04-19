-- scripts/migrations/sql/353_users_last_login.sql
-- Phase 3 reconciliation: re-add users.last_login.
--
-- Migration 349 dropped last_login as part of the "GoTrue owns login history"
-- trim, but some admin-UI code paths still query this column. Rather than
-- ripping every call site now, re-add the column so the admin platform works
-- end-to-end. Long-term: migrate readers to fetch from auth.users
-- (GoTrue's last_sign_in_at) and drop this column in a future migration.
--
-- NOTE: This column was already added ad-hoc to production on 2026-04-19 via
-- `ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login` during the Phase 3
-- admin-auth rollout. This migration file formalises that change so dev and
-- any fresh-from-migrations database stay in sync.

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS last_login timestamp with time zone;
