# K-035 — Failed payment webhooks are discarded on retry

**Claim (BB F02):** the event record commits before processing, so a processing failure returns 500 but redelivery is treated as a duplicate and never retried.

**Corrected trigger:** `pages/api/webhooks/paystack.ts` runs outside any request transaction — `withErrorHandler` opens none, and `src/lib/neon.ts` routes each tagged template straight to the pool when no ALS client is bound. So the `INSERT INTO paystack_webhook_events` at lines 128-132 auto-commits before `processEvent` is called at line 139. On a throw the handler returns 500 (line 154) and only stamps `processing_error`; `processed` stays false. Paystack redelivers the byte-identical body, the `body_sha256` lookup at lines 123-126 finds the committed row, and the handler answers `200 {duplicate:true}` without processing. The event is lost with no automatic recovery — no job re-reads `processed = false`.

**Disposition: confirmed.** Second, related defect proved by the same test: the `UPDATE paystack_payment_requests ... RETURNING` at lines 206-216 also auto-commits before the throw, so even a manual replay cannot re-enter the branch (its guard is `AND status <> 'completed'`).

**Reachability:** public route, reached by any signature-valid Paystack delivery.

**Evidence**
- RED `tests/integration/k-035-webhook-redelivery-discarded.int.test.ts` on the disposable production schema. No provider call is made — this route never contacts Paystack. The processing failure is real rather than injected: a company with one `active` and one `pending` mandate makes the `authorization` branch's blanket `UPDATE subscription_mandates SET status='active' WHERE company_id=$1 AND status IN ('pending','active')` (lines 255-269) violate `ux_sub_mandates_company_active` (migration 429, per the plan's H50/F13 note). `bun run test:integration -- <file>` → **2 failed / 1 passed** (`red.log`).
  - passing: first delivery is 500 and leaves `processed = false` with a `processing_error`;
  - failing: the identical redelivery returns `{duplicate: true}` and `processed` is still false;
  - failing: the payment request is already `completed` despite the failure.
- File unchanged 5661d6f0..ebeac9ca.

**Proposed minimal fix** (`pages/api/webhooks/paystack.ts`)
1. Change the dedupe short-circuit at lines 123-126 to return 200 only when the existing row has `processed = TRUE`; otherwise fall through and reprocess.
2. Replace the separate SELECT + INSERT with a single `INSERT ... ON CONFLICT (body_sha256) DO NOTHING RETURNING id`, falling back to a SELECT, so two concurrent redeliveries cannot both insert.
3. Wrap `processEvent` and its downstream writes in one `withTransaction` from `@/lib/neon` so a failure rolls back the `paystack_payment_requests` mutation with it, and mark `processed` inside that transaction.

**Historical-data impact:** any event stuck at `processed = false` was acknowledged and dropped; the corresponding payment may be settled at Paystack but unrecorded here.
```sql
SELECT id, event_type, reference, received_at, left(processing_error, 160) AS err
FROM paystack_webhook_events
WHERE processed = false
ORDER BY received_at DESC;
```
Rows with a non-null `processing_error` need manual replay from `payload`; each should be reconciled against `paystack_payment_requests.status` for the same reference.

**Risks:** reprocessing must be idempotent per branch. `charge.success` and `charge.failed` are already guarded by their `status <> 'completed'` / `NOT IN ('completed','failed')` predicates, but with fix 3 those guards only hold if the failed attempt's write is rolled back — ship 1 and 3 together, never 1 alone.
