# R-030 fix — the invite-token session can read the one company its token names

**Trigger.** See `validation.md`. The invitation lookup joins `companies`, whose only read policy is
`companies_member_read (id IN auth.user_companies())`. The anonymous invite-token session has no JWT, that
set is empty, the join dropped every row, and every valid invitation answered 410. `/accept-invite` calls
this route first, so the entire GoTrue accept-invite flow was dead for every tenant.

**Before.** 410 "Invitation not found, expired, or already accepted" for a live invitation.
**After.** 200 with the company name and the masked invitee address. Migration 643 adds
`companies_invite_token_read`: SELECT on `companies` for `app_user` where an invitation exists for that
company whose `token` equals the `app.invite_token` GUC and which is neither accepted nor expired — the
same terms `invites_by_token` already grants on the invitation itself. Outside an invite-token session the
GUC is empty, `nullif` makes the comparison NULL, and the policy grants nothing.

**Files.** `scripts/migrations/sql/643_invite_token_encoding_and_companies_read.sql`,
`pages/api/invitations/[token]/index.ts` (email masking, K-105 defence in depth).

**Tests.** `tests/integration/k104-k105-invitation-token-encoding.int.test.ts` — 3 R-030 tests, real
PostgreSQL. A live invitation resolves 200 with the masked email; expired, accepted and unknown tokens all
410. Adjacent tenant cases: the invite-token session sees that one company and no other, a session with an
unknown token sees none, and an expired invitation exposes neither the invitation nor the company.
Mutation: dropping `companies_invite_token_read` fails 3 tests; removing the masking fails 1
(green.log M5, M3).

**Migration / rollback.** Migration 643, prefix chosen as the first free of every branch (619-642 taken
across all refs and worktrees). `DROP POLICY IF EXISTS` first, so it is re-runnable. Rollback:
`DROP POLICY companies_invite_token_read ON public.companies` — that restores the broken behaviour.

**Historical impact.** No stored data is wrong. Operational only: every invitation mailed through
`POST /api/invitations` has been unusable since RLS was forced on `companies`. Read-only, NOT run here:
```sql
SELECT count(*) FROM company_invitations
WHERE gotrue_user_id IS NOT NULL AND accepted_at IS NULL;
```
Those people were never onboarded and need a resend; migration 643 expires the rows so the resend works.

**Limits.** The policy is a correlated EXISTS on every `companies` SELECT for `app_user`. That role is used
only by the invite-token path, where the query reads one row by primary key.
