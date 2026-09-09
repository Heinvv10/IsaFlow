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
`scripts/migrations/sql/648_invite_company_name_security_definer.sql`,
`pages/api/invitations/[token]/index.ts` (no join onto `companies`; email masking for K-105).

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

**Narrowed by migration 648 (review M1).** 643's grant was a ROW policy, so it exposed all 163 columns of
the tenant row — `netcash_service_key`, `netcash_payouts_key`, `bank_account_number`, `bank_branch_code`
and the SARS contact fields among them — to anyone holding an invitation link. 648 replaces it with
`invite_token_company_name()`, a SECURITY DEFINER function (pinned `search_path`, EXECUTE granted to
`app_user` only) that returns `name` on exactly the terms the policy granted, and drops the row policy.
The endpoint no longer joins `companies` at all. Proven: the invite session now reads zero rows from
`companies` and zero from `SELECT netcash_service_key, bank_account_number`, while still getting the name.

**Limits.** `app_user` is NOT invite-only — `withAuth`, `bearerPipeline`, `withExtensionToken` and
`withPlatformAdmin` all `SET LOCAL ROLE app_user`, so a permissive policy on `companies` is ORed onto
`companies_member_read` and its correlated EXISTS is evaluated on every `companies` SELECT in the product.
That was the real cost of 643's policy, and 648 removes it: there is no invite policy on `companies` any
more, so authenticated traffic pays nothing. The function is evaluated once per invitation lookup and
returns NULL whenever `app.invite_token` is unset, which is every non-invite session.


---

## Blind-review findings on effc7d4d — all nine fixed

| # | Finding | Disposition |
|---|---|---|
| H1 | `accept.ts` had no `gotrue_user_id IS NOT NULL` guard, so a `userInvitationService` invitation reached it and PUT a password to `/admin/users/null` | Fixed. Guard added to the step-1 SELECT; the lookup answers 409 `WRONG_INVITE_FLOW` and `/accept-invite` forwards to `/invite/<token>`, which is the flow that can complete it. Test "H1: a userInvitationService invitation is sent to its own flow". |
| M1 | The new row policy granted all 163 columns of `companies`, including Netcash keys and the bank account number | Fixed by migration 648, above. Test asserts the invite session reads zero rows and zero secret columns. |
| M2 | This file claimed `app_user` is used only by the invite path | Fixed. The Limits paragraph above is rewritten and now names the four other middlewares; 648 removes the app-wide cost entirely. |
| L1 | `InviteTokenRequest.inviteToken` (the raw token) orphaned | Fixed. Field and its assignment removed; the doc comment says why only the digest is exposed. |
| L2 | `ROLLBACK` on a client with no open transaction after a GoTrue failure | Fixed. An `opened` flag tracks the BEGIN; `BEGIN` was NOT moved above the GoTrue calls, which would hold a transaction open across two external HTTP round-trips. |
| L3 | `/accept-invite` still said "Set your password" to someone who must type their existing one | Fixed. `SIGN_IN_REQUIRED` relabels the field and the lead-in copy. |
| L4 | No attempt cap on accept, so it is a password oracle | Fixed. `checkRateLimit('invite-accept:<digest>')`, ten attempts an hour. Charged at cost 2 against a ceiling of 20 on purpose: the limiter short-circuits on its in-process LRU below half the limit, which under-counts exactly a guessing burst, and cost > 1 always reaches the shared counter. Test drives 12 attempts and asserts 10x401 then 2x429. |
| L5 | Migration 643 kept the old SMTP error via `COALESCE`, hiding its own retirement note | Fixed. The note is appended after ` | ` when an `email_error` is already present. |
| L6 | A re-invite at a new role did not change an existing member's role | Fixed. `ON CONFLICT (company_id, user_id) DO UPDATE SET role = EXCLUDED.role`. Test re-invites an existing viewer as manager and asserts the change. |

Mutation proof for each is in `green.log`: dropping the H1 guard, neutering the 409, restoring 643's row
policy, dropping the 648 function, removing the attempt cap and restoring `DO NOTHING` each turn a test red.
