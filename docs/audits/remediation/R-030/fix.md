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

**Files.** `scripts/migrations/sql/662_invite_token_encoding_retire_stale.sql` (this file was
`643_invite_token_encoding_and_companies_read.sql` when this section was written; see round-3 M2/M3),
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

---

## Blind re-review round 2 on 74a1e7c4 — eight findings, seven fixed, one disclosed

| # | Finding | Disposition |
|---|---|---|
| M1 | The 409 forward closed a click-loop: `/invite/<t>` → `/register?invite=<t>` → `/accept-invite` → 409 → `/invite/<t>`, so a brand-new invitee on the `userInvitationService` flow could never reach a signup form | Fixed. `/accept-invite` now forwards to `/invite/<token>?signup=1`; that page (and `/login?invite=`) propagates `&signup=1` onto its "Create an Account" CTA; `/register` skips its `/accept-invite` bounce when the flag is set. The flag is written only by the 409 branch, so an invitation the accept-invite flow *can* complete keeps its old routing. Tests: `tests/unit/components/inviteSignupLoop.test.tsx` (5). |
| M2 | `L6`'s `DO UPDATE` covered one of the two acceptance routes | Fixed. `pages/api/invite/[token].ts` now does `ON CONFLICT (company_id, user_id) DO UPDATE SET role = EXCLUDED.role` too — it accepts the same rows. Test: `tests/integration/k-041-invite-page-reinvite-role.int.test.ts` (2). |
| L1 | The `opened` guard (round-1 L2) is carried by no test | **OVERTURNED in round 3 — now tested; see the round-3 table below.** The round-2 text, kept for the record: *Disclosed, not fixed.* The logic is right and the consequence of getting it wrong is a PostgreSQL `WARNING`, not a defect; the client is created inside `accept.ts` from a private pool, so no test at this seam can observe a notice on it. Recorded here so the claim is not read as mutation-proof: replacing `if (opened) await client.query('ROLLBACK')` with the unconditional call leaves every test green. |
| L2 | The SECURITY DEFINER function ran as a superuser with `public` ahead of `pg_catalog` | Fixed by **migration 655**. `SET search_path = pg_catalog, public` and `OWNER TO migration_admin` (whose `rolbypassrls` is the only privilege the body needs). New migration rather than an edit to 648: `apply-migrations.ts` refuses on a checksum mismatch. Test asserts `proowner`/`rolsuper`/`proconfig` and that the function still answers correctly. |
| L3 | The attempt counter joined the invite-token transaction, so a thrown path un-counted it | Fixed. `als.exit(() => checkRateLimit(...))` runs the counter on the module pool, so it survives `withInviteToken`'s ROLLBACK and no longer holds that key's row lock across two GoTrue round-trips. Test: a GoTrue outage mid-accept, asserting the counter row persists at 2. |
| L4 | The rate-limit key was unauthenticated and caller-chosen | Fixed. The `checkRateLimit` call moved below the 410, so only a token that resolves to a real invitation mints a `rate_limit_counters` row. Still ahead of every GoTrue call. Test asserts no row for an unknown token. |
| L5 | `minLength={10}` and the server floor survived the existing-password relabel | Fixed. `accept.ts` checks presence up front and applies the ten-character floor only on the `!isEstablished` branch; `/accept-invite` drops `minLength` once `needsExistingPassword`. Tests: an established account with a six-character password accepts; a brand-new invitee is still refused at `short`. |
| L6 | Migration 643 was edited after it had been applied | **SUPERSEDED in round 3 — the remedy printed here was UNSAFE; see round-3 M2 below and do not follow it.** The round-2 text, kept for the record: *Disclosed.* Any database that ran 643 at `effc7d4d` — the review fixture and the shared dev databases — will fail `db:migrate` on a checksum mismatch rather than skipping. Expected. 643 is on no other branch and not in production; the fix for a dev database is to delete its `schema_migrations` row for 643 and re-apply. Migration 655 deliberately does not repeat the mistake. |

Round-2 mutation proof (green.log): the L5 floor moved back to the top, the `!isEstablished` floor
removed, the limiter charged before the lookup, `als.exit` dropped, `DO NOTHING` restored on
`/api/invite/[token]`, `signup=1` dropped from each of the three pages that carry it, and re-applying
648 over 655 each turn a test red. L1 is the one change no mutation kills, and says so above.

---

## Blind re-review round 3 on 6b1f62e7 — eleven findings

| # | Finding | Disposition |
|---|---|---|
| H1 | K-106 was fixed only against a mock: `sendEmail` never throws, so the `catch` that writes `email_error` was unreachable and a failed send reported `emailSent: true` | Fixed. `POST /api/invitations` branches on the returned `EmailResult` and keeps the `catch` for a genuine throw. Every invitation test's `sendEmail` mock now returns the module's real contract. Detail in `docs/audits/remediation/K-106/fix.md`. |
| M1 | 663 (was 655, briefly 661) guarded its `ALTER FUNCTION … OWNER TO migration_admin` on the role existing, so the one statement carrying the security property silently no-opped and the migration still reported success | Fixed. The `ALTER` is unconditional. `348_rls_and_auth_helpers.sql` creates `migration_admin` and grants to it unconditionally, so a database reaching this migration without the role is broken and must fail loudly. Probed on the fixture: the guarded form with an absent role leaves the function owned by superuser `postgres` and reports success; the unconditional form errors `role … does not exist`. |
| M2 | The round-2 L6 remedy re-executed 643 alone, re-creating the whole-row `companies` grant that 648 removed — Netcash keys, bank account number, branch code, SARS contacts, to any invite-link holder, with 648 and 655 already recorded as applied and so never re-running to close it | Fixed at the source rather than in prose. The `CREATE POLICY companies_invite_token_read` statement is **deleted** from that migration, which is now `662_invite_token_encoding_retire_stale.sql` and contains only the data retirement. Re-applying it cannot grant anything. **If anyone followed the old remedy** (delete the `schema_migrations` row for 643 and re-apply, or `scripts/migrations/resolve-checksum-conflicts.ts`, which re-executes the file at line 88) on a database that had already run 643 *and* 648, that database now has `companies_invite_token_read` back and nothing will drop it: run `DROP POLICY IF EXISTS companies_invite_token_read ON public.companies;` and confirm with `SELECT polname FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid WHERE c.relname = 'companies';` — the expected set is `companies_admin_update, companies_member_read` and nothing else. **Production was never exposed**: 643 has never been on `origin/master` and has never been applied there; a fresh database applying 662 → 648 → 663 lands in the same verified state. |
| M3 | Prefix 643 is taken by `643_control_exception_workflow.sql` on another unmerged branch | Fixed. `643_invite_token_encoding_and_companies_read.sql` → `662_invite_token_encoding_retire_stale.sql`, and `655_invite_company_name_definer_hardening.sql` → `663_…` — renumbered so M1's correction did not need a checksum-conflict remedy at all, and landing on 662/663 rather than 660/661 because K-110 committed `660_cost_centre_parent_delete_restrict.sql` and 661 is reserved for a K-140 follow-up. 648 keeps its prefix — it collides with nothing — and keeps its `DROP POLICY IF EXISTS`, which is what closes the hole on databases that ran the old 643. The renumbering also removes the round-2 L6 conflict outright: `scripts/apply-migrations.ts` matches recorded rows by filename and ignores a recorded name with no file, so a dev database that ran 643/655 — or 660/661, the intermediate numbers this branch briefly used — simply applies 662/663 next, both of which are idempotent. |
| L1 | The `opened` ROLLBACK guard is testable after all — spy on `pg.Pool.prototype.connect` | Fixed, exactly as the reviewer proved. The spy is installed before the module under test is imported, wraps both the promise and callback forms of `connect`, and records queries per client, so `withInviteToken`'s legitimate ROLLBACK on its own transaction is not confused with one on the admin client. The GoTrue-outage test now asserts the admin client issued neither `BEGIN` nor `ROLLBACK`. Mutation: dropping `if (opened)` turns it red. |
| L2 | The guard shipped the `users`-row half of its validation and not the `email_confirmed_at` half | **Disputed — the proposed remedy would break the route entirely, so only the disclosure half is taken.** `POST /api/invitations` calls `adminCreateUser({ email_confirm: true })`, so **every** invite-minted GoTrue user has `email_confirmed_at` set from the moment the invitation is created. Treating that as "established" would send every brand-new invitee to the 401 "enter that account's password" branch for a password that has never been set — the flow would not work for anyone. Nor is there a reliable substitute signal: `user_metadata.invite_id` and a `created_at` comparison both misclassify the ordinary revoke-then-re-invite path (`pages/api/invitations/revoke/[id].ts` deletes the row, so the new invitation has a new id and post-dates the user) and would lock those invitees out. The narrowing is therefore deliberate and recorded: the residual is a GoTrue account that is confirmed, has a self-chosen password and has **no** `users` row — i.e. someone who registered and whose tenant provisioning did not complete. Only the mailbox owner can reach the invite link, so the acceptor and the account owner are the same person; the shipped guard is strictly broader than the validation's `AND`, not narrower. |
| L3 | `?signup=1` is attacker-settable, so the routing decision came from an unauthenticated query flag | Fixed. `/register` now asks `GET /api/invitations/<token>` and takes the signup form only on that endpoint's own 409 `WRONG_INVITE_FLOW`; a fetch failure falls back to the acceptance page. The flag is no longer read. The pages that still append it are harmless and were left alone. Tests: `?signup=1` on an accept-flow token still redirects; a 409 shows the form; an unreachable endpoint redirects; no `?invite=` shows the form immediately. |
| L4 | 655 detects 648 being re-applied over it; it does not survive it | Accepted, wording corrected: the `proconfig` assertion in `k104-k105-invitation-token-encoding.int.test.ts` is **detection in CI**, not immunity in a database. In normal ordering 663 always runs after 648, and M2 removes the re-apply path that was the only way to hit it. |
| L5 | The data half was not idempotent — the retirement note accumulated on every re-apply | Fixed. 662's `WHERE` excludes rows whose `email_error` already carries the note, in every wording this file has ever written (662, 660, 643) — a database that ran it under an older number carries that number in the note. Probed on the fixture: applying it twice updates 2 rows then 0, the note appears once, and a pre-existing SMTP error is preserved ahead of it. |
| L6 | The raw 64-hex invite token was written to the application log | Fixed. `pages/api/invite/[token].ts` logs `inviteId` instead. Test asserts on what the logger was handed — the raw token appears in no log payload and the invitation id does. Mutation: restoring `{ token, … }` turns it red. |
| L7 | Neither anonymous invite route had `withErrorHandler`, so any throw answered a bare Next HTML 500 that `/accept-invite` reported as "Network error" | Fixed. Both are `withErrorHandler(withInviteToken(handler))` — **outside**, not inside, so `withInviteToken` still ROLLBACKs before the JSON error is written. The GoTrue-outage test now asserts a 500 JSON body with `code: 'INTERNAL_SERVER_ERROR'`. Mutation: removing the wrapper makes the request throw again and turns the test red. |

Round-3 mutation proof (green.log): ignoring `emailResult.success`, dropping `if (opened)`, dropping
`withErrorHandler`, restoring the raw token in the log line, and restoring the `?signup=1` flag each turn a
test red; the M1 owner guard is proved by direct probe on the fixture rather than by a test, since it is a
property of a database that lacks `migration_admin`.
