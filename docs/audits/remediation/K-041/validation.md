# K-041 — invitation accept overwrites an existing account's password

**Claim.** `pages/api/invitations/[token]/accept.ts:54` sets a password unconditionally, so
inviting an existing account resets its credentials.

**Corrected trigger.** Not "any accept". Only when the invited address ALREADY has a GoTrue
account: `pages/api/invitations/index.ts:55` calls `adminCreateUser`, which on HTTP 422 falls
back to `adminGetUserByEmail` (`src/lib/auth/gotrue.ts:106-109`) and stashes that EXISTING
user id on the invitation (`index.ts:62-65`). Accept then PUTs a new password onto it with no
current-password check and no proof the link holder owns the account.

**Disposition: confirmed.**

**Evidence.** Baseline `origin/master` = `0f16391e`; file unchanged since the audited
`5661d6f0` (`git log 5661d6f0..origin/master -- <path>` empty). Read with `git show`.
RED test drives the real handler through `withInviteToken` against the disposable
PostgreSQL fixture, with GoTrue stubbed at the fetch boundary:
`tests/integration/k-041-invite-accept-overwrites-existing-password.int.test.ts` — 1 test,
1 failed. The handler returned 200 and issued
`PUT /admin/users/<existing user id>` carrying `password: "attacker-chosen-password-2026"`.
Log: `docs/audits/remediation/K-041/red.log`.

**Reachability.** Any owner/admin can invite any email address. The invite token is emailed
and is not returned by `GET /api/invitations`, so the normal actor is the invitee. Practical
effect: an invitation to a second company silently replaces the login the person already uses
for their first company, and no old-password confirmation gates it. Full takeover needs the
token, which no API path exposes.

**Proposed minimal fix.** In `accept.ts`, before step 2, resolve the GoTrue user
(`adminGetUserByEmail`) and branch: when `email_confirmed_at` is set AND a `users` row already
exists for that id, skip `adminUpdateUser` entirely, require an authenticated session for that
same `sub` (or a sign-in with the current password) and only then insert the `company_users`
membership. Keep the password-setting path for genuinely new accounts. 4 files unchanged;
one branch in `accept.ts` plus a `users` existence check.

**Historical impact.** No corrupted accounting rows. Affected people are existing users whose
password was reset by accepting a later invitation. Read-only impact query (run on production
by the operator; not run here):
```sql
SELECT ci.company_id, ci.email, ci.accepted_at
FROM company_invitations ci
JOIN users u ON lower(u.email) = ci.email
WHERE ci.accepted_at IS NOT NULL AND u.created_at < ci.created_at;
```

**Risks.** The fix changes the accept flow for existing accounts; the UI must present a
"sign in to accept" path or those invitations become un-acceptable.
