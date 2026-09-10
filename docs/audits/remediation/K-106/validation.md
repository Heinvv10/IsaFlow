# K-106 — Invitation 502 path advises resending a rolled-back invitation

**Claim.** The error message tells the user to resend an invitation the transaction already discarded.

**Disposition: confirmed.**

**Corrected trigger.** `pages/api/invitations/index.ts:83-88` catches an email-send failure, writes `email_error`, and returns 502 with "Invitation created but email delivery failed. You can resend." `src/lib/auth/withAuth.ts:224-226` computes `handlerFailed = res.statusCode >= 500` and issues `ROLLBACK`. 502 satisfies that, so the INSERT at `:47`, the `gotrue_user_id` UPDATE at `:62` and the `email_error` UPDATE at `:86` are all discarded. Nothing exists to resend, the Users list shows no pending invitation, and `email_error` is never persisted for diagnosis. The GoTrue user created at `:55` is outside the transaction and survives as an orphan.

**Evidence.** Files above read with `git show origin/master:<path>`.

**RED test.** `tests/integration/k106-invitation-502-rollback.int.test.ts` — 1 failed of 1. Observed `{status: 502, rowsPersisted: 0, message: "Invitation created but email delivery failed. You can resend."}` against expected `rowsPersisted: 1`. Log: `red.log`.

**Reachability.** Any owner or admin whose SMTP send fails. `feedback_email_sent_is_not_delivered` records that sends do fail in this system.

**Proposed minimal fix (3-6 lines).** Return 201 with `{ emailSent: false, emailError }` instead of 502, matching what `pages/api/accounting/company-invitations.ts:100-110` already does. That keeps the row committed and makes the message true. If the 502 status must stay, delete the "You can resend" wording and say the invitation was not created.

**Historical-data impact.** Orphaned GoTrue users exist for every 502'd invite: an auth account with a confirmed email and no `company_users` membership and no invitation row. Read-only impact requires the GoTrue schema:
```sql
SELECT count(*) FROM auth.users au
WHERE NOT EXISTS (SELECT 1 FROM company_users cu WHERE cu.user_id::text = au.id::text)
  AND NOT EXISTS (SELECT 1 FROM company_invitations ci WHERE ci.gotrue_user_id = au.id);
```
Not run here; production is out of scope for this validation.

**Risks.** Switching to 201 changes the contract the Users page reads; check `pages/accounting/user-access.tsx` handles `emailSent: false`.
