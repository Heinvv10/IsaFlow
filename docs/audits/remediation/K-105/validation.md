# K-105 — Invitation lookup leaks the invitee email and ignores expiry

**Claim.** The public lookup returns the full email and does not check expiry or prior acceptance.

**Disposition: false-positive (both halves), with a larger separate defect found.**

**Disconfirming evidence.**
- Expiry and prior acceptance ARE enforced, by RLS rather than by the handler. `scripts/migrations/sql/348_rls_and_auth_helpers.sql:154-159` defines `invites_by_token` as `token = current_setting('app.invite_token') AND accepted_at IS NULL AND expires_at > now()`. `src/lib/auth/withInviteToken.ts:43-44` does `SET LOCAL ROLE app_user` and sets that GUC, and `app_user` is neither superuser nor BYPASSRLS (verified: `SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname='app_user'` → `f, f`). The fixture confirms the policy text verbatim.
- No email can leak, because the route never returns 200 at all. See below.

**Larger defect found (new).** `pages/api/invitations/[token]/index.ts:14-16` joins `companies c ON c.id = ci.company_id`. `companies` has forced RLS whose only read policy is `companies_member_read: id IN auth.user_companies()`. In the anonymous invite-token session there is no JWT, so that set is empty, the join drops every row, and the handler answers 410 "Invitation not found, expired, or already accepted" for a perfectly valid invitation. The `/accept-invite` page (`pages/accept-invite.tsx:19`) calls this before it can accept, so the whole GoTrue accept-invite flow is dead. Direct probe:
```
SET LOCAL ROLE app_user; SELECT set_config('app.invite_token', <token>, true);
company_invitations alone            -> 1 row
JOIN companies                       -> 0 rows
```

**RED test.** `tests/integration/k104-k105-invitation-token-encoding.int.test.ts`, test "K-105: the public lookup resolves a live invitation, masks the email, and refuses expired/accepted ones" — 1 failed. Observed `{freshStatus: 410, emailReturned: null, expiredStatus: 410, acceptedStatus: 410}` against expected `freshStatus: 200`. It fails on the route being dead, not on a leak. Log: `red.log`.

**Proposed minimal fix (3-6 lines).** Add a `companies` RLS policy for the invite-token session, or drop the join and read the company name through a `SECURITY DEFINER` helper keyed on the invitation's `company_id`. Separately, mask the email as `pages/api/invite/[token].ts:29-33` already does, for defence in depth.

**Historical-data impact.** None to stored data. Operational impact only: every invitation mailed by system 1 has been unusable since RLS was forced on `companies`. Read-only check for affected rows:
```sql
SELECT count(*) FROM company_invitations
WHERE gotrue_user_id IS NOT NULL AND accepted_at IS NULL;
```

**Risks.** The new finding is higher severity than the claim it replaces and should be raised as its own item.
