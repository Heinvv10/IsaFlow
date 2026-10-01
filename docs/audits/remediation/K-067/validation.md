# K-067 — EFT builders truncate over-long values

**Claim.** `padLeft` truncates rather than rejecting, so an oversized value is
silently written as a different number.

**Corrected trigger.** `padLeft` (eftService.ts:45-48) is
`s.length > length ? s.substring(s.length - length) : s.padStart(length, '0')`
— it keeps the LAST `length` characters. Nothing upstream bounds any field:
`validateEFTBatch` (line 75) checks only non-empty and amount > 0, and it never
calls `validateBankAccount`, which itself checks no length either.

**Disposition: CONFIRMED as a latent defect in the pure builders. NOT reachable
through its only caller today, because that caller is separately broken.**

**Evidence.** RED test `tests/unit/eft/k067-eft-padleft-truncation.test.ts`:
**3 tests, 3 failed**. R1,000,000,000.00 is 100000000000 cents, and the
11-digit field receives `00000000000` — a billion rand written as zero. A
13-digit account number `9876543210123` is written as `76543210123`. Both reach
the generated Standard Bank file unchanged.

**Reachability — and the blocker.** The only caller is
`pages/api/accounting/eft-generate.ts` (grep over `pages`, `src`, `tests`). It
builds each `EFTPayment` with `amount: Number(p.amount || 0)` (line 71) from
`SELECT sp.*, s.name, s.bank_account_number, ...`. **`supplier_payments` has no
`amount` column** and neither does `suppliers` — verified against the fixture
schema (`information_schema.columns`): the column is `total_amount`. So every
payment carries `amount: 0`, `validateEFTBatch` answers "Amount must be greater
than zero", and the route 400s before any generator runs. The header is wrong
the same way: it reads `company_name`, `bank_account_number`, `bank_branch_code`
and `payment_date` off `supplier_payment_batches`, which has none of them (it
has `bank_account_id` and `batch_date`), so branch code and account number fall
back to `''` and the action date to today.

**Proposed fix.** Two separate changes, and the second is the larger finding:
1. eftService: make `padLeft` throw (or have `validateEFTBatch` reject) when the
   value exceeds the field, and call `validateBankAccount` from
   `validateEFTBatch` for every payment.
2. eft-generate.ts: read `sp.total_amount`, and source the header's bank
   account, branch code and action date from the batch's `bank_account_id`
   join and `batch_date`. **Register this as its own finding** — the EFT export
   cannot succeed for any company in its present state.

**Historical-data impact.** Nil for the truncation: no EFT file can have been
generated through this route while the amount column mismatch stands, so no
payment file carries a truncated figure from it. The impact of (2) is a feature
that has never worked, not corrupted data.

**Risks.** Rejecting over-long values turns a silently wrong file into a failed
export; that is the intended trade. Fixing (2) makes the generators reachable,
so (1) must land with or before it — otherwise the fix activates the defect.
