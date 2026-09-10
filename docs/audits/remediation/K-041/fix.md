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

**Round-5 dispositions (0 HIGH; 3 MEDIUM, 7 LOW).**
- *M1 — `profileName()`'s 255 cap split a UTF-16 surrogate pair, so an astral name
  reached Postgres as `22021 invalid byte sequence` and 500ed AFTER the password was set.*
  Fixed: the cap counts code points (`[...trimmed].slice(0, 255).join('')`). VARCHAR(255)
  counts characters, so 255 astral code points still fit.
- *M2 — the `users`-row discriminator misses an unconfirmed `register.ts` signup: the pending
  registration's password was overwritten and `signIn` then failed `email_not_confirmed`,
  answering 500 on every retry.* Fixed: the new-invitee branch patches
  `email_confirm: true` alongside the password. `adminCreateUser` returns early on a 422 and
  never applies the flag `POST /api/invitations` passes it, so this is not redundant. Holding
  the invitation link is the same mailbox proof the verification mail asks for. **The round-3
  L2 disposition recorded above is wrong on its premise and is withdrawn.**
- *M3 — 662 collides with `662_forensic_export_delivery.sql` on unmerged branches.* NOT taken,
  by explicit instruction: K-041 keeps 662 and the forensic branch renames at merge time.
  Renumbering again would force re-proving the multi-prefix idempotency guard added for
  round-4 M1, which is the more expensive thing to get wrong. The guard is what makes either
  order safe.
- *L1 — 662 was edited in place under a name this branch had already applied.* Real, and NOT
  cleared by a renumber now that M3 is declined. The edited file has a new checksum, so
  `bun run db:migrate` refuses the whole run on any developer DB that already applied 662 at
  `98c54f883`. **Production is unaffected: `origin/master` has never carried this file under
  any number (643/648/662/663 are all branch-only), so production has no tracking row and the
  sweep will run correctly exactly once when this branch merges.**

  Remedy — correct the recorded checksum WITHOUT re-running the file:
  ```sql
  -- value = sha256 of scripts/migrations/sql/662_invite_token_encoding_retire_stale.sql
  -- recompute with: sha256sum scripts/migrations/sql/662_invite_token_encoding_retire_stale.sql
  UPDATE schema_migrations
     SET checksum = '418dd946be81fc5a36a1ac0c6ce6fc94e4875edd808d9fff14cec7f6bb81ce45'
   WHERE name = '662_invite_token_encoding_retire_stale.sql';
  ```
  Then `bun run db:migrate` proceeds to 663 and beyond. If the tracking row has already been
  deleted, put it back without executing the SQL — `bun scripts/apply-migrations.ts --backfill`
  (documented at `scripts/apply-migrations.ts:7` as "mark pending as applied without running
  SQL"). Note `--backfill` uses `ON CONFLICT (name) DO NOTHING`, so it will NOT repair a
  mismatched checksum on a row that still exists; that case needs the UPDATE above.

  **Do NOT `DELETE FROM schema_migrations WHERE name = '662_…'` and re-apply.** An earlier
  version of this document advised exactly that, and it is wrong: the round-4 M1 guard added
  in this round is `NOT EXISTS (SELECT 1 FROM schema_migrations WHERE name LIKE
  '%\_invite\_token\_encoding\_retire\_stale.sql')`, and deleting the row is precisely what
  makes it true again. The sweep then runs a SECOND time and expires every invitation minted
  between the two runs — those carry the new sha256 encoding, are perfectly valid, have no
  `email_error` note to exclude them, and match `gotrue_user_id IS NOT NULL AND accepted_at IS
  NULL AND expires_at > now()`. That is the round-4 M1 defect, re-enabled by the remedy.

  If you already followed the old advice on a developer DB, list what the second sweep hit and
  resend those invitations from the Users page (read-only; developer DBs only):
  ```sql
  SELECT company_id, email, created_at, expires_at, email_error
  FROM company_invitations
  WHERE accepted_at IS NULL
    AND email_error LIKE '%retired by migration 662%'
  ORDER BY created_at DESC;
  ```
  A row whose `created_at` is later than the first `db:migrate` run against `98c54f883` was
  valid and was wrongly expired. Resending mints a fresh token and clears `email_error`.
- *L2 — the concurrent loser of the `users_email_key` race got an opaque 500.* Fixed: the 409
  is answered from the 23505 itself (`code === '23505' && constraint === 'users_email_key'`),
  and the pre-check `SELECT` that could not close the window is deleted. One mechanism, no
  race, one fewer round-trip on every accept.
- *L3 — three sha256 helpers in the module that exists to be the single one.* Fixed:
  `pages/api/invite/[token].ts` and `userInvitationService.ts` import `hashInviteToken`; both
  local copies deleted.
- *L4 — whitespace-only edits.* Reverted in `pages/login.tsx` and `pages/invite/[token].tsx`.
- *L5 — 508-line test file against the 300-line ceiling.* Fixed: fixture and GoTrue stub moved
  to `tests/integration/k-041-invite-accept.helpers.ts` (254), rounds 1-3 stay in the original
  file (230), rounds 4-6 in `k-041-invite-accept-adjacent.int.test.ts` (191).
- *L6 — wrong path in the 663 header.* Fixed: `scripts/apply-migrations.ts`.
- *L7 — the ten-attempt budget was charged to non-guesses.* Fixed: `refundRateLimit(key, units)`
  hands the units back on the two verdicts reachable only AFTER `signIn` has succeeded
  (`IDENTITY_MISMATCH`, `EMAIL_IN_USE`). Nothing an unauthenticated caller can reach is
  refunded — a wrong password, a GoTrue outage and a 429 all still cost 2 — so the counter
  cannot be spent down into a free-attempt loop. `GREATEST(count - cost, 0)` floors it and
  leaves `window_start` alone, so a refund can never extend a window.

**Round-5 tests.** 6 integration files / 34 tests green on the fixture DB. New:
`tests/integration/k-041-invite-accept-adjacent.int.test.ts` — 6 tests, three of them new
(astral name cut on a code point with no lone surrogate; `email_confirm: true` in the
new-invitee admin patch; `IDENTITY_MISMATCH` refunded to zero), plus the `EMAIL_IN_USE`
case now asserting its refund. Full unit suite with `DATABASE_URL` unset: 9438 passed /
234 skipped, 792 files. Mutation-proved (green.log): reverting the code-point cap, deleting
`email_confirm`, letting 23505 escape, and deleting both `refund()` calls each turn the
matching test RED.

**Round-5 historical impact.** None new; no schema or data change. M1 and M2 could only ever
have produced 500s — no row was written wrongly by either. L7's population is
`rate_limit_counters` rows that will expire on their own within the hour.

**Round-5 limits.** `refundRateLimit`'s zero floor is not itself exercised by a test: no
production path refunds twice, so the only way to reach it is a contrived call. The floor is
`GREATEST(count - cost, 0)` in one statement and visible in the diff.

**Round-6 disposition (0 HIGH, 0 MEDIUM, 1 LOW — reviewer verdict DONE).**
- *LOW-1 — the documented dev-DB remedy for L1 disarmed the round-4 M1 guard.* Fixed, in this
  document only: the L1 entry above now corrects the checksum instead of deleting the tracking
  row, spells out what the old advice would have done, and gives a read-only query for anyone
  who already followed it. No code, test, migration or schema change in this round — the
  reviewer's own probes (34 integration tests, `tsc`, eslint, the live-GoTrue `email_confirm`
  matrix, the `app_user` RLS matrix, the DEFINER ownership/ACL read) all stand unchanged.
