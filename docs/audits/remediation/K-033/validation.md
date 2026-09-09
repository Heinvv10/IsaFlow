# K-033 — Subscription period advances before Paystack settles

**Claim (AA C3):** the period is rolled forward when the charge is queued and never rolled back or marked past due after three failed attempts.

**Corrected trigger:** `generateDueCharges()` writes the queued `subscription_charges` row and then unconditionally advances `subscriptions.current_period_start/_end` in the same iteration (`git show ebeac9ca:src/modules/billing/services/subscriptionBillingService.ts` lines 111-131). Paystack is not called until the separate `runQueuedCharges()` pass. Once `attempt_count` hits `MAX_ATTEMPTS` (3) the charge drops out of the retry query (line 175) and nothing touches the subscription: `status` stays `'active'` on the advanced period. The next cron run after that advanced period expires generates a *second* charge and advances again, so a permanently declining card accrues unpaid periods indefinitely.

**Disposition: confirmed.**

**Reachability:** `pages/api/cron/subscription-charges.ts:39-40` runs both functions hourly behind `X-Cron-Secret`.

**Evidence**
- RED `tests/integration/k-033-subscription-period-advances-before-settlement.int.test.ts` on the disposable production schema, `chargeAuthorization` mocked (no network). `bun run test:integration -- <file>` → **2 failed / 2** (`red.log`).
  - period end moves +1 month while the charge is still `queued`;
  - after 3 rejected attempts the charge is `failed`/`attempt_count=3` and the subscription is still `active` on the advanced period.
- File unchanged 5661d6f0..ebeac9ca (`git log --oneline 5661d6f0..ebeac9ca -- <path>` empty).

**Proposed minimal fix** (`src/modules/billing/services/subscriptionBillingService.ts`)
1. Drop the `UPDATE subscriptions ... current_period_*` block (lines 125-131); the charge row already carries `period_start`/`period_end`.
2. Advance the period where settlement is observed instead: `runQueuedCharges` when `localStatus === 'settled'`, and the webhook's `subscription_charge` branch (`pages/api/webhooks/paystack.ts:273-281`), both keyed off the charge's period.
3. In the `runQueuedCharges` failure path, when `attempt_count + 1 >= MAX_ATTEMPTS`, also set `subscriptions.status = 'past_due'` for that company.
4. Keep the duplicate guard (lines 79-86) — it keys on the charge period, so it still suppresses a second charge for an unsettled period.

**Historical-data impact:** any company whose period advanced on a charge that never settled got unpaid service and carries a wrong `current_period_end`.
```sql
SELECT s.company_id, s.id AS subscription_id, s.status, s.current_period_end,
       c.period_start, c.period_end, c.status AS charge_status, c.attempt_count, c.amount_cents
FROM subscriptions s
JOIN subscription_charges c ON c.company_id = s.company_id
WHERE c.gateway = 'paystack' AND c.status IN ('queued','submitted','failed')
  AND s.current_period_end > c.period_start
ORDER BY c.period_start;
```

**Risks:** moving the advance to settlement changes what the admin billing UI shows mid-debit; step 3 flips companies to `past_due`, which any feature gate reading `subscriptions.status` will act on. Check `past_due` consumers before merge.
