# K-042 fix — re-inviting the same address resends instead of 500ing

**Trigger.** `company_invitations` declares `UNIQUE(company_id, email)` (migration 258) and the
row is never cleared on accept — only `accepted_at` is stamped. `POST /api/invitations`
INSERTed with no conflict handling and the route was `withAuth(withCsrf(handler))` with no
`withErrorHandler`, so both a resend to a pending invitee and a re-invite of someone who
accepted and was later removed raised PostgreSQL 23505 and escaped as a bare 500.

**Before.** Second invite to the same address in the same company: 500, nothing written, the
only way through was revoking (which deletes the row).
**After.** `ON CONFLICT (company_id, email) DO UPDATE` refreshes the row in place — new token,
new expiry, the role just chosen, `accepted_at`/`email_sent_at`/`email_error` cleared — which
is the resend the existing 502 branch already promises. The conflict target is tenant-scoped,
so another company's invitation for the same address is never touched. The route is now
`withAuth(withErrorHandler(withCsrf(handler)))`, the repo pattern, so any other upstream
failure answers a JSON envelope rather than a bare 500.

**Files.** `pages/api/invitations/index.ts` (+18/-2).

**Tests.** `tests/integration/k-042-reinvite-unique-violation.int.test.ts` — 5 tests, real
PostgreSQL fixture, GoTrue and the email service stubbed: resend returns 201 and refreshes the
same row; a second tenant's invitation for the same address is unchanged; a re-invite at a new
role rewrites the role and pushes the expiry out; an unknown role 400s without writing; an
upstream GoTrue failure returns a 500 envelope instead of throwing. Mutation check: removing
the `ON CONFLICT` clause fails 2, removing `withErrorHandler` fails 1 (green.log).

**Migration / rollback.** None. Revert the file.

**Historical impact.** No data corruption — the failed resends wrote nothing. What exists are
invitations that were never delivered and could not be resent. Read-only, for the operator to
run on production (NOT run here):
```sql
SELECT company_id, email, created_at, email_error
FROM company_invitations
WHERE accepted_at IS NULL AND (email_sent_at IS NULL OR email_error IS NOT NULL);
```

**Limits.** Rotating the token invalidates a previously mailed link. That is what a resend
means, but nothing may call this endpoint from a background job. Re-inviting someone who
already accepted clears `accepted_at`, so the invitation list shows them as pending again
while their existing `company_users` membership stays in place; the fix does not revoke it.
