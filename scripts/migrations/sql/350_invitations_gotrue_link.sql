-- scripts/migrations/sql/350_invitations_gotrue_link.sql
-- Phase 2: Link company_invitations to the GoTrue user we admin-created.

ALTER TABLE public.company_invitations
  ADD COLUMN IF NOT EXISTS gotrue_user_id uuid;

CREATE INDEX IF NOT EXISTS idx_company_invitations_gotrue_user_id
  ON public.company_invitations(gotrue_user_id) WHERE gotrue_user_id IS NOT NULL;
