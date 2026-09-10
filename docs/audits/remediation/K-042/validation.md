# K-042 — re-inviting the same email returns 500

**Claim.** `pages/api/invitations/index.ts:47` inserts with no conflict handling, so a resend
raises a unique violation.

**Corrected trigger.** The unique key is `(company_id, email)`, declared by
`scripts/migrations/sql/258_company_invitations.sql` and present in the fixture schema as
`company_invitations_company_id_email_key`. The row is never cleared on accept — only
`accepted_at` is stamped (`accept.ts:83-86`) — so BOTH a resend to a still-pending invitee and
a re-invite of someone who already accepted and was later removed hit it. Revoking
(`pages/api/invitations/revoke/[id].ts:38`) deletes the row and is the only way through today.

**Disposition: confirmed.**

**Evidence.** Baseline `origin/master` = `0f16391e`; file unchanged since `5661d6f0`.
RED test drives the real route through `withAuth`/`withCsrf` against the disposable fixture:
`tests/integration/k-042-reinvite-unique-violation.int.test.ts` — 1 test, 1 failed. The call
rejected with PostgreSQL `23505` on `company_invitations_company_id_email_key`, raised at
`pages/api/invitations/index.ts:47`. Log: `docs/audits/remediation/K-042/red.log`.

**Reachability.** `withAuth(withCsrf(handler))` — there is no `withErrorHandler` in the chain,
so the error escapes `withAuth` (`src/lib/auth/withAuth.ts:268-270` rethrows) and Next answers
500 with no actionable message. The rate-limit gate at :33 is passed long before the insert.

**Proposed minimal fix.** Make the insert idempotent per tenant: add
`ON CONFLICT (company_id, email) DO UPDATE SET role = EXCLUDED.role, invited_by =
EXCLUDED.invited_by, token = EXCLUDED.token, expires_at = EXCLUDED.expires_at,
accepted_at = NULL, email_error = NULL RETURNING id` at `index.ts:47-51`. That turns a resend
into a fresh token with a fresh expiry, which is the behaviour the 502 branch at :87 already
promises ("You can resend").

**Historical impact.** No data corruption; failed resends wrote nothing. Rows whose
`email_error` is set or `email_sent_at` is NULL are invitations that were never delivered and
could not be resent:
```sql
SELECT company_id, email, created_at, email_error
FROM company_invitations
WHERE accepted_at IS NULL AND (email_sent_at IS NULL OR email_error IS NOT NULL);
```

**Risks.** Rotating the token on conflict invalidates a previously mailed link. That is the
intended semantics of a resend, but it must not be run from a background job that could
silently break a link the invitee is about to click.
