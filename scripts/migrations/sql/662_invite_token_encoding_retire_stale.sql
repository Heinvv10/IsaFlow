-- 662: retire the invitations whose raw tokens no longer match anything.
--
-- Renumbered from 643, then from 660 (K-110 committed
-- 660_cost_centre_parent_delete_restrict.sql first). Two reasons for the first
-- renumber, both from the round-3 review:
--
--  * prefix 643 is taken by 643_control_exception_workflow.sql on another
--    unmerged branch, and the repo rule is one file per prefix;
--  * this file used to also CREATE POLICY companies_invite_token_read on
--    public.companies -- a ROW policy, so it granted all 163 columns of the
--    tenant row (netcash_service_key, netcash_payouts_key, bank_account_number,
--    bank_branch_code, the SARS contacts) to any holder of an invite link.
--    Migration 648 replaced it with a SECURITY DEFINER function returning the
--    company NAME and nothing else, and dropped the policy. Leaving the CREATE
--    POLICY here meant that re-applying this one file -- which is exactly what
--    a checksum-conflict remedy does -- re-opened that grant, with 648 already
--    recorded as applied and so never re-running to close it again. The
--    statement is gone: this migration can no longer grant anything.
--
-- K-104. POST /api/invitations stored the RAW token while
-- userInvitationService stored sha256(token) into the same column. Both are
-- forced onto one row by UNIQUE(company_id, email). The application now hashes
-- on every write and every lookup, so rows still holding a raw token can never
-- match again — they would sit in the Users list as pending forever. Expire
-- them so they read as expired and can be resent. Deliberately cross-tenant:
-- this retires a platform-wide encoding change, not one company's data, and it
-- is scoped to invitations that were never accepted.

-- gotrue_user_id IS NOT NULL marks the rows POST /api/invitations wrote; that
-- column is set by no other path. Only unaccepted, not-yet-expired ones need
-- touching — the rest already read as expired or done.
UPDATE public.company_invitations
-- Appended, not COALESCEd: an invitation whose email had already failed
-- carries an SMTP error here, and those are exactly the rows an operator hunts
-- for. Keeping only the old message would expire them silently.
SET expires_at = now(),
    email_error = CASE
      WHEN email_error IS NULL OR email_error = ''
        THEN 'Invitation link retired by migration 662 (token encoding change) — please resend'
      ELSE email_error || ' | Invitation link retired by migration 662 (token encoding change) — please resend'
    END
WHERE gotrue_user_id IS NOT NULL
  AND accepted_at IS NULL
  AND expires_at > now()
  -- Idempotent: a re-apply must not append a second copy of the note. Every
  -- wording this file has ever written is excluded, not just the current one --
  -- a database that ran it under 643 or 660 carries that number in the note.
  AND (email_error IS NULL
       OR email_error NOT LIKE '%retired by migration 662%'
       AND email_error NOT LIKE '%retired by migration 660%'
       AND email_error NOT LIKE '%retired by migration 643%');
