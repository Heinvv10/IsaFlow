# K-041 fix — invite accept no longer overwrites an existing account's password

**Trigger.** `POST /api/invitations` calls `adminCreateUser`, which on a 422 returns the
EXISTING GoTrue user (`src/lib/auth/gotrue.ts`) and stashes that id on the invitation.
`pages/api/invitations/[token]/accept.ts` then called `adminUpdateUser({ password })` on it
unconditionally, so whoever held the invite link set the password of a login that already
existed — for a company they were never a member of, with no ownership proof.

**Before.** Accept always PUT a new password, then signed in with it. 200.
**After.** Accept first asks, on the BYPASSRLS admin connection, whether a `users` row exists
for the invitation's `gotrue_user_id`. `users` rows are written only by tenant provisioning
(post email verification) and by accept itself, so the row is the durable evidence that a
password already exists.
- Row present: `adminUpdateUser` is never called. The typed password is a credential CHECK —
  it must sign in. Success attaches the membership and issues that person's own session;
  failure is 401 `SIGN_IN_REQUIRED`. A signed-in `sub` that does not equal the invitation's
  `gotrue_user_id` is 409 `IDENTITY_MISMATCH`.
- No row: unchanged registration path, the typed password becomes the password.
The read must run on the admin pool: RLS on `users` is `id = auth.uid()`, and `auth.uid()` is
empty inside the invite-token transaction, so a `sql` read would always see zero rows and the
guard would never fire.

**Files.** `pages/api/invitations/[token]/accept.ts` (+47/-15).

**Tests.** `tests/integration/k-041-invite-accept-overwrites-existing-password.int.test.ts` —
10 tests, real PostgreSQL fixture, GoTrue stubbed at the fetch boundary: no password patch and
no membership on a wrong password; membership attached and prior-company membership untouched
on the correct one; accepted-token replay 410s; a brand-new invitee still gets a password and a
profile row. Mutation check: restoring the file from `origin/master` fails all 4 (green.log).

**Migration / rollback.** None. Revert the file.

**Historical impact.** No accounting rows are wrong. Affected people are existing users whose
password was replaced by accepting a later invitation. Read-only, for the operator to run on
production (NOT run here):
```sql
SELECT ci.company_id, ci.email, ci.accepted_at, u.created_at AS account_created_at
FROM company_invitations ci
JOIN users u ON lower(u.email) = ci.email
WHERE ci.accepted_at IS NOT NULL AND u.created_at < ci.created_at;
```

**Blind-review follow-ups (both now done).** The attempt cap this section asked for exists:
`checkRateLimit('invite-accept:<digest>')`, ten tries an hour, charged at cost 2 so the
limiter's in-process short-circuit cannot under-count a guessing burst (review L4).
`/accept-invite` relabels the password field on `SIGN_IN_REQUIRED` (review L3). Two more
landed here: the `ROLLBACK` after a GoTrue failure is now guarded by an `opened` flag, since
the GoTrue calls run before `BEGIN` (L2); and the membership insert uses
`ON CONFLICT (company_id, user_id) DO UPDATE SET role = EXCLUDED.role`, so re-inviting an
existing member at a new role actually changes it (L6).

**Round-2 follow-ups.** The ten-character floor now applies only to a brand-new invitee: for an
established account the typed password is proof of ownership, and applying a rule about SETTING a
password locked out anyone provisioned before the floor existed (r2 L5). The attempt counter runs
via `als.exit` on the module pool, so a GoTrue outage no longer un-counts the attempt with the
invite-token ROLLBACK (r2 L3), and it is charged after the 410 so an invented token cannot mint a
`rate_limit_counters` row (r2 L4). `pages/api/invite/[token].ts` got the same `DO UPDATE` as this
route (r2 M2).

**Round-3 follow-ups.** The `opened` ROLLBACK guard is no longer an untested claim: a spy on
`pg.Pool.prototype.connect`, installed before the module is imported, records queries per client, and the
GoTrue-outage test asserts the admin client issued neither `BEGIN` nor `ROLLBACK` (r3 L1 — the round-2
"no mutation kills this" disclosure is withdrawn). Both anonymous invite routes are now
`withErrorHandler(withInviteToken(handler))`, outside so the rollback still runs first, so a GoTrue outage
answers JSON instead of a bare Next HTML 500 that `/accept-invite` reported as "Network error" (r3 L7).
`/register` takes the signup-form decision from `GET /api/invitations/<token>` rather than from the
attacker-settable `?signup=1` flag (r3 L3). `pages/api/invite/[token].ts` logs the invitation id, not the
raw token (r3 L6). The three migrations are renumbered (662, 648, 663) and the whole-row `companies` grant
is deleted from 662 outright, so no re-apply of any of them can re-open it (r3 M2/M3). The
`ALTER FUNCTION … OWNER TO migration_admin` in 663 is unconditional (r3 M1). One finding is disputed: r3 L2
asked for `email_confirmed_at` to count as "established", but `POST /api/invitations` creates every invitee
with `email_confirm: true`, so that test is true for every brand-new invitee and would refuse all of them —
evidence and the residual are in `docs/audits/remediation/R-030/fix.md`.

**Limits.** A legitimate invitee who genuinely forgets their password gets ten tries an hour
against this endpoint and must then use password reset. A brand-new invitee on the
`userInvitationService` flow can now reach the signup form (r2 M1), but `SignupForm` has no
invitation handling of its own: registering creates that person's own tenant, and they join the
inviting company by reopening the emailed `/invite/<token>` link once signed in. That is the
pre-existing shape of that flow, not something this branch changed. Full per-finding dispositions,
both rounds, are in `docs/audits/remediation/R-030/fix.md`.

**Round-4 dispositions (0 HIGH; 1 MEDIUM, 6 LOW — all fixed).**
- *M1 — 662 cannot tell a raw token from a hashed one, so a replay under a third number expires
  live invitations.* Fixed. The sweep is correct exactly once per database, so it is now gated on
  `NOT EXISTS (SELECT 1 FROM schema_migrations WHERE name LIKE '%\_invite\_token\_encoding\_retire\_stale.sql')`.
  The runner matches applied migrations by filename and inserts a file's own tracking row only
  *after* its statements run (`scripts/apply-migrations.ts:applyOne`), so the guard never blocks the
  run executing it, and any earlier number (643, 660) still bars a second sweep. A date bound was
  rejected: `ON CONFLICT … DO UPDATE` keeps `created_at` on a resend and clears `email_error`, so a
  date misclassifies in both directions. Proved on the fixture inside `BEGIN … ROLLBACK` (green.log).
- *L1 — dead `&signup=1` chain.* Fixed by deletion: `/accept-invite` forwards to `/invite/<token>`
  with no flag, and neither `/invite/[token]` nor `/login` computes or appends one. `/register` was
  already deciding from the server's 409 and never read it.
- *L2 — a whole `pg.Pool` per accept attempt.* Fixed: memoised module-level pool, `admin.end()`
  dropped, matching `src/lib/neon.ts` and `src/lib/auth/withInviteToken.ts`.
- *L3 — `users_email_key` 23505 escaping as a 500.* Fixed: an in-transaction pre-check for another
  `users` row holding the invited address answers 409 `EMAIL_IN_USE` and rolls the acceptance back.
  The unique index remains the authority — a concurrent insert in the gap still raises 23505; this
  turns the reachable case into an actionable message.
- *L4 — acceptance reverted an established profile email.* Fixed: `email = EXCLUDED.email` removed
  from the conflict branch. A new row still gets the invited address on INSERT.
- *L5 — unvalidated `firstName` / `lastName` from an anonymous body.* Fixed: `profileName()`
  type-checks, trims, empties to NULL and bounds to 255 (the column width) before the values reach
  GoTrue metadata or `users`.
- *L6 — 662 is unscoped cross-tenant DML.* Accepted deviation, now recorded in the migration
  header: a platform-wide encoding change has no company to scope to, and it is bounded to
  unaccepted, unexpired invitations.
- *L2 (round-3 dispute) — `email_confirmed_at` guard.* Overturned in the author's favour by the
  round-4 reviewer against live GoTrue; the shipped `users`-row discriminator stands. No change.

**Round-4 tests.** Three added to
`tests/integration/k-041-invite-accept-overwrites-existing-password.int.test.ts` (10 → 13): the
email-clash 409 with full rollback and the legacy row untouched; an established profile email
surviving acceptance; a numeric `firstName` and a 400-character `lastName` accepted and bounded.
`tests/unit/components/inviteSignupLoop.test.tsx` (8) now pins the absence of the flag. Every one
is mutation-proved in green.log, including the migration guard.

**Round-4 historical impact.** None new. M1 cannot have fired on production (`origin/master` has
never carried this file under any number); a developer database that ran it as 643 or 660 is the
population the guard protects, and no row is retroactively wrong. L3's population is read-only:
```sql
SELECT ci.company_id, ci.email, u.id AS clashing_user_id
FROM company_invitations ci
JOIN users u ON lower(u.email) = lower(ci.email) AND u.id <> ci.gotrue_user_id::text
WHERE ci.accepted_at IS NULL AND ci.gotrue_user_id IS NOT NULL;
```
