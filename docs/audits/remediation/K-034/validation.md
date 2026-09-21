# K-034 — Scheduled cancellation ignored during renewal

**Claim (BB F33):** `generateDueCharges` selects expired active subscriptions without consulting `cancel_at_period_end`, so cancelled customers are charged again.

**Corrected trigger:** `cancelSubscription(id, true)` sets only `cancel_at_period_end = true` and leaves `status = 'active'`, `cancelled_at` NULL (`git show ebeac9ca:src/modules/admin/services/billingService.ts` lines 261-275). `generateDueCharges` filters on `s.status IN ('active','past_due')` alone (`.../subscriptionBillingService.ts` lines 50-52) and never reads `cancel_at_period_end`. Nothing anywhere transitions a `cancel_at_period_end` subscription to `cancelled` — grep for the column returns only the admin service, its types, and the UI. So at period end the customer is debited again *and* rolled into a fresh period, permanently.

**Disposition: confirmed.** Distinct root cause from K-033 (which is advance-before-settlement); not a duplicate.

**Reachability:** UI `CompanyBillingTab.tsx:81` → `PUT/POST pages/api/admin/billing/subscriptions/[id]/cancel.ts:32` with `atPeriodEnd` → the cron at `pages/api/cron/subscription-charges.ts:39`.

**Evidence**
- RED `tests/integration/k-034-cancel-at-period-end-ignored.int.test.ts` on the disposable production schema, `chargeAuthorization` mocked (no network). `bun run test:integration -- <file>` → **2 failed / 1 passed** (`red.log`).
  - passing test documents the trigger: after `cancelSubscription(id, true)` the row is `{cancel_at_period_end: true, status: 'active'}`;
  - failing: `generateDueCharges` creates a `queued` charge for the cancelled subscription;
  - failing: the same call rolls `current_period_end` forward another month.
- Both files unchanged 5661d6f0..ebeac9ca.

**Proposed minimal fix**
1. `src/modules/billing/services/subscriptionBillingService.ts` line 50-52: add `AND COALESCE(s.cancel_at_period_end, false) = false` to the due-subscription query.
2. Same loop: for a due subscription with the flag set, write the terminal state instead of a charge — `UPDATE subscriptions SET status='cancelled', cancelled_at=now() WHERE id = ...` — and count it under `skipped`.
3. Add the corresponding GREEN assertions to the K-034 test.

**Historical-data impact:** every charge raised for a subscription flagged to cancel is an over-collection; the customer was also kept in an active period they had cancelled.
```sql
SELECT s.company_id, s.id AS subscription_id, s.updated_at AS flagged_at,
       c.id AS charge_id, c.period_start, c.period_end, c.amount_cents, c.status, c.settled_at
FROM subscriptions s
JOIN subscription_charges c ON c.company_id = s.company_id
WHERE COALESCE(s.cancel_at_period_end, false) = true
  AND c.created_at >= s.updated_at
ORDER BY c.created_at;
```

**Risks:** step 2 makes the cron a writer of terminal subscription state — a company that re-subscribes before the period ends must clear the flag first, or the cron will cancel it. Verify the reactivation path in `billingService.updateSubscription` resets `cancel_at_period_end`; on ebeac9ca it does not.
