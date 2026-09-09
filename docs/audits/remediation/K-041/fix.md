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
4 tests, real PostgreSQL fixture, GoTrue stubbed at the fetch boundary: no password patch and
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

**Limits.** A legitimate invitee who genuinely forgets their password gets ten tries an hour
against this endpoint and must then use password reset. Full per-finding dispositions are in
`docs/audits/remediation/R-030/fix.md`.
