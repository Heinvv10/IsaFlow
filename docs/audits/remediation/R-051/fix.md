# R-051 (residual) — `approveVATAdjustment` posts once, and a refused approval writes nothing

## Scope

R-051 inventoried the check-then-act posting class left after K-107. Re-verified on
`origin/master` a30e44177 (2026-09-24): `confirmCustomerPayment` / `cancelCustomerPayment`,
`generateJournalFromRecurring`, `applyTaxDirective` and `markUifDeclarationPaid` are already
claim-guarded. Two parts were still live:

1. `reports/vatAdjustmentService.approveVATAdjustment` — fixed here.
2. `trg_cp_payment_number` / `trg_sp_payment_number` mint `MAX+1` with no unique index on either
   payments table (confirmed on the schema fixture: no index on `payment_number`). Adding one is a
   migration that fails if prod already holds duplicates, so it needs the census below first. Split
   out as R-128; not changed here.

## Defect

`approveVATAdjustment` read the adjustment's status with a plain SELECT, created and POSTED the
journal, then stamped `status='approved'` with an UPDATE that did not re-check the status.

- **Double post.** A second approval that reads `draft` while the first is still in flight posts a
  second journal: the VAT figure moves twice. The free race is usually stopped by accident — the
  loser collides on `uq_gl_je_company_entry_number` (23505) or deadlocks (40P01) — but when the
  second request blocks between its read and its insert (measured: on the first approval's
  fiscal-year auto-creation) it mints the next entry number after the first commits and both
  succeed.
- **Orphan draft behind a 400.** `postJournalEntry` refuses some journals only after
  `createJournalEntry` inserted the draft (closed fiscal period, inactive account). The route's
  catch answers every failure 400, and `withAuth` COMMITs a 4xx, so the draft stayed.
- A foreign or missing id answered 400 "Action failed", not 404.

(The locked-VAT-period refusal is raised in `createJournalEntry` BEFORE the draft exists, so it never
left a draft; its test is a regression test only. The closed fiscal period is the measured case.)

## Measured (red.log)

Against master's service and route: the deterministic interleaving posts two journals (both 200);
the closed-period approval leaves a draft journal; 404 and 409 cases red. 5 of the 9 tests that existed at that run red (red.log); the BYPASSRLS scope test was added after.

## Fix

- `lockAdjustmentForUpdate`: the adjustment row `FOR UPDATE`, company-scoped, with a 5s
  `lock_timeout` (reset on success). The second approval waits for the first to commit, reads
  `approved`, and is refused. `cancelVATAdjustment`'s `status='draft'` UPDATE waits on the same
  row, so approve and cancel serialise too.
- Refusals are typed (`VatAdjustmentRefusal`: `not_found` → 404, `not_draft` → 400, `contended`
  → 409) and are all raised before the first write.
- The journal create, post and the adjustment stamp run inside one `withSavepoint`, so any refusal
  from `postJournalEntry` rolls the draft back before the route answers 400.

### Review round 1

rev-r051-adversarial: SHIP with three LOWs; rev-r051-general: LOWs. All fixed:
- Contention (55P03/40P01) and a journal-number collision (23505 on `uq_gl_je_company_entry_number`,
  the R-043 race) raised inside approve's savepoint answer 409, not 400 "Action failed"; the
  savepoint has already rolled them back, so the 409 commits nothing.
- The route validates `id` as a uuid (400 with a reason) instead of letting 22P02 answer "Action failed".
- Closed fiscal period, inactive account and locked VAT period refusals answer 400 with their own message.
- `cancelVATAdjustment` waits on the same row under the same 5s bound (409), and refuses with typed
  `not_found` (404) / `not_draft` (400, naming the status).
- Tests: the 409 case is bounded (a regression fails in 15s instead of hanging with the row held);
  the VAT-lock case is labelled a regression test; new `r051-vat-adjustment-route.int.test.ts` (5).

## Tests

- `tests/integration/r051-vat-adjustment-approve.int.test.ts` (10), through
  `POST /api/accounting/vat-adjustments-action` (withAuth, app_user, RLS). The deterministic race
  holds the adjustment row from the test and tracks the blocked backends by `pg_blocking_pids`
  (never by statement text — the fixture database is shared).
- `tests/unit/services/reports/vatAdjustmentService.test.ts` now runs inside a stub request
  transaction.
- Mutations: 13 of 13 killed (`mutations.log`; N8 initially survived behind RLS and is killed by the BYPASSRLS scope test; N9–N13 cover review round 1).

## Census SQL for Hein (prod, read-only — agents never run this)

```sql
-- 1. Double posts: an adjustment with more than one live journal.
SELECT va.company_id, va.id, va.adjustment_number, va.status, va.gl_journal_entry_id,
       COUNT(je.id) AS journals, array_agg(je.entry_number ORDER BY je.created_at) AS entries
  FROM vat_adjustments va
  JOIN gl_journal_entries je
    ON je.company_id = va.company_id AND je.source = 'auto_vat_adjustment'
   AND je.description = 'VAT adjustment ' || va.adjustment_number
   AND je.status = 'posted' AND je.reversed_at IS NULL
 GROUP BY va.company_id, va.id, va.adjustment_number, va.status, va.gl_journal_entry_id
HAVING COUNT(je.id) > 1;

-- 2. Orphan drafts left behind a refused approval.
SELECT je.company_id, je.id, je.entry_number, je.entry_date, je.description, je.created_at
  FROM gl_journal_entries je
 WHERE je.source = 'auto_vat_adjustment' AND je.status = 'draft'
   AND NOT EXISTS (SELECT 1 FROM vat_adjustments va
                    WHERE va.company_id = je.company_id AND va.gl_journal_entry_id = je.id);

-- 3. R-128 pre-check: duplicate payment numbers (a unique index cannot be added while any exist).
SELECT 'customer_payments' AS t, company_id, payment_number, COUNT(*)
  FROM customer_payments WHERE payment_number IS NOT NULL
 GROUP BY company_id, payment_number HAVING COUNT(*) > 1
UNION ALL
SELECT 'supplier_payments', company_id, payment_number, COUNT(*)
  FROM supplier_payments WHERE payment_number IS NOT NULL
 GROUP BY company_id, payment_number HAVING COUNT(*) > 1;
```
