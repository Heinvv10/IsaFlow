# K-111 — Merge and time-entry actions always report zero rows changed

**Claim.** The code reads `rowCount` off a result the `sql` tag returns as `res.rows`, so the operator's only feedback is always zero.

**Disposition: confirmed. Second call site expressed differently from the claim.**

**Corrected trigger.** `src/lib/neon.ts:96-112` resolves every tagged-template query to `res.rows`, an array. An `UPDATE` without `RETURNING` therefore resolves to `[]`.
- `src/modules/accounting/services/core/duplicateMergeService.ts:13` declares `type SqlResult = { rowCount?: number }` and eleven call sites (`:57,63,69,75,81,109,115,121,152,161,170`) do `Number(rX.rowCount ?? 0)`. `rowCount` is undefined on an array, so every term is 0 and `reassignedTransactions` is always 0.
- `src/modules/accounting/services/core/timeTrackingService.ts:209` and `:225` do NOT use `rowCount`; they do `Array.isArray(result) ? result.length : 0` on the same empty array. Same root cause, different expression — the claim's wording is wrong here, the conclusion is right.

The writes themselves succeed. Only the count is wrong, and it is the operator's sole feedback. `src/modules/accounting/services/bank/bankTransactionQueryService.ts:208` already carries a comment documenting exactly this hazard.

**Evidence.** Files above via `git show origin/master:<path>`.

**RED test.** `tests/integration/k111-merge-and-timesheet-row-counts.int.test.ts` — 2 failed of 2. Merge: three supplier invoices actually moved, `reassignedTransactions` reported 0. Timesheets: two entries actually moved to `submitted`, `submitEntries` returned 0. Log: `red.log`.

**Reachability.** `POST /api/accounting/duplicates-merge` for owner/admin/manager, and the timesheet submit and approve actions for any user with time entries.

**Proposed minimal fix (3-6 lines).** Append `RETURNING id` to each affected `UPDATE` and count `rows.length`:
```ts
const r1 = await sql`UPDATE supplier_invoices SET supplier_id = ... RETURNING id`;
count += r1.length;
```
Delete the `SqlResult` type and the `as unknown as SqlResult` casts in `duplicateMergeService.ts` so the mistake cannot be re-made, and change `submitEntries`/`approveEntries` the same way.

**Historical-data impact.** None. No stored value is wrong; the defect is in reported feedback only. The operational risk is an operator reading "0 transactions reassigned" as a failed merge and repeating or reversing it — a repeat is idempotent, but a manual reversal of a merge that did land would move live documents to the wrong supplier.

**Risks.** Low. `RETURNING id` on these statements adds no semantic change.
