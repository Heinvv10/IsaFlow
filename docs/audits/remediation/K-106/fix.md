# K-106 fix — the failed-invite-email response now describes what survived

**Trigger.** `POST /api/invitations` caught an email-send failure, wrote `email_error`, and returned 502
with "Invitation created but email delivery failed. You can resend." `withAuth` computes
`handlerFailed = res.statusCode >= 500` and issues ROLLBACK (`src/lib/auth/withAuth.ts:224-226`), so the
INSERT, the `gotrue_user_id` UPDATE and the `email_error` UPDATE were all discarded. Nothing existed to
resend, the Users list showed no pending invitation, and the failure reason was never persisted.

**Before.** 502, zero rows persisted, message advising a resend of something that did not exist.
**After.** 201 with `{ emailSent: false, emailError }`, matching what
`pages/api/accounting/company-invitations.ts:100-110` already does. The row, its `gotrue_user_id` and its
`email_error` survive, so the invitation is visible and diagnosable and a resend has something to resend.
The success path now also reports `emailSent: true`.

**Round-3 H1 — the failure was reported as success in production.** The first version of this fix
detected the failure with a `try/catch` alone. `sendEmail` **never throws** on a delivery failure: it
returns `{ success: false, error }` from its "SMTP not configured" branch and from its own `catch`
(`src/modules/accounting/services/core/emailService.ts`). So the catch was unreachable, `email_error` was
never written, `email_sent_at` was stamped anyway, and the caller was told `emailSent: true` for mail no
SMTP server had accepted. The route now branches on the returned `EmailResult` and keeps the `catch` for a
genuine throw. The tests mocked a throw — a shape the real module cannot produce — and passed while
production was wrong; the mocks in `k106`, `k-042` and `k104-k105` now return the real
`{ success, messageId? }` / `{ success: false, error }` contract.

**Files.** `pages/api/invitations/index.ts`.

**Tests.** `tests/integration/k106-invitation-502-rollback.int.test.ts` — 3 tests, real PostgreSQL, email
service stubbed with its real return contract. Asserts status 201, one row persisted, `email_sent_at` NULL
and `email_error` set when the send RESOLVES a failure; `emailSent: true` with `email_sent_at` stamped and
`email_error` NULL on the adjacent success case; and the same recorded outcome when `sendEmail` genuinely
throws. Mutations: restoring the 502 fails the test; ignoring `emailResult.success` (the round-3 defect)
turns the first test red with `emailSent: true, emailError: undefined`.

**Contract check.** No caller in the repo POSTs `/api/invitations` (`grep` over `pages/` and `src/`), so
the 201 body change breaks no page. The Users page uses `/api/accounting/company-invitations`.

**Migration / rollback.** None. Revert the file.

**Historical impact.** Orphaned GoTrue users exist for every invite that 502'd: the `adminCreateUser` call
is outside the transaction and survived the rollback. Read-only, needs the GoTrue schema, NOT run here:
```sql
SELECT count(*) FROM auth.users au
WHERE NOT EXISTS (SELECT 1 FROM company_users cu WHERE cu.user_id::text = au.id::text)
  AND NOT EXISTS (SELECT 1 FROM company_invitations ci WHERE ci.gotrue_user_id = au.id);
```

**Limits.** Pre-existing orphaned GoTrue users are not cleaned up by this change.
