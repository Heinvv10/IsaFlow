-- scripts/migrations/sql/990_users_login_count.sql
-- Admin audit 2026-11-14 item 1.1: the admin console's "Login Count" read COUNT(*) FROM user_sessions, a table
-- nothing has written since GoTrue took over sessions, so it was 0 for every user. Migration 349 dropped
-- users.login_count together with last_login; 353 re-added last_login only. Re-add the counter so sign-in can
-- maintain it next to last_login (src/lib/auth/recordSignIn.ts, run on the migration_admin pool, which holds
-- table-level UPDATE on users; no app role gets a grant on this column).
-- Additive and idempotent: existing rows start at 0 (the old session count was never a login count).

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS login_count integer NOT NULL DEFAULT 0;
