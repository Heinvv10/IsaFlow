-- Migration 260: Add email tracking columns to company_invitations
-- Tracks whether the invite email was sent and records any send errors.

ALTER TABLE company_invitations
  ADD COLUMN IF NOT EXISTS email_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS email_error   TEXT;
