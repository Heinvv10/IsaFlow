-- 643: make the invite-token session able to read its own company, and retire
-- the invitations whose raw tokens no longer match anything.
--
-- Two defects, one row shape:
--
-- R-030 (from K-105). pages/api/invitations/[token]/index.ts joins `companies`,
-- which has FORCE ROW LEVEL SECURITY and one read policy, companies_member_read
-- (id IN auth.user_companies()). The accept-invite session has no JWT, so that
-- set is empty, the join dropped every row, and every valid invitation answered
-- 410 "not found, expired, or already accepted". The whole /accept-invite flow
-- was dead. Grant exactly the company the presented invite token names, on the
-- same terms invites_by_token already grants the invitation itself: live token,
-- not accepted, not expired. Outside an invite-token session the GUC is empty,
-- nullif makes the comparison NULL, and the policy grants nothing.
--
-- K-104. POST /api/invitations stored the RAW token while
-- userInvitationService stored sha256(token) into the same column. Both are
-- forced onto one row by UNIQUE(company_id, email). The application now hashes
-- on every write and every lookup, so rows still holding a raw token can never
-- match again — they would sit in the Users list as pending forever. Expire
-- them so they read as expired and can be resent. Deliberately cross-tenant:
-- this retires a platform-wide encoding change, not one company's data, and it
-- is scoped to invitations that were never accepted.

DROP POLICY IF EXISTS companies_invite_token_read ON public.companies;
CREATE POLICY companies_invite_token_read ON public.companies FOR SELECT TO app_user
  USING (EXISTS (
    SELECT 1 FROM public.company_invitations ci
    WHERE ci.company_id = public.companies.id
      AND ci.token = nullif(current_setting('app.invite_token', true), '')
      AND ci.accepted_at IS NULL
      AND ci.expires_at > now()
  ));

-- gotrue_user_id IS NOT NULL marks the rows POST /api/invitations wrote; that
-- column is set by no other path. Only unaccepted, not-yet-expired ones need
-- touching — the rest already read as expired or done.
UPDATE public.company_invitations
SET expires_at = now(),
    email_error = COALESCE(email_error, 'Invitation link retired by migration 643 (token encoding change) — please resend')
WHERE gotrue_user_id IS NOT NULL
  AND accepted_at IS NULL
  AND expires_at > now();
