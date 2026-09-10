# K-074 — GL posted before the subledger update, both under one 400

**Claim.** A throw in the subledger UPDATE commits the GL and bank side with the invoice still
unpaid. (`pages/api/accounting/bank-match-confirm.ts:1639` at `5661d6f0`; the file is 274 lines
and unchanged on `origin/master`, so the cited line number is wrong — the code is at :109-126.)

**Disposition: confirmed**, with a stronger corrected trigger than the claim states.

**The ordering defect.** `origin/master:pages/api/accounting/bank-match-confirm.ts:109` calls
`allocateTransaction`, which posts the journal entry (`bankAllocationService.ts:372-375`),
updates `bank_transactions` and may write a supplier payment document. Only then, at `:119`,
does the route update the subledger. The catch at `:266-270` turns ANY failure into
`apiResponse.badRequest` — a 400 — and `withAuth` decides COMMIT vs ROLLBACK on
`statusCode >= 500`. The route's own comment at `:74-76` names this hazard and moves one guard
before the writes; the catch-all still converts every post-write failure into a committing 400.

**The trigger is not hypothetical.** That UPDATE assigns `balance`, which migration
`scripts/migrations/sql/201_accounts_payable.sql:31` declares
`GENERATED ALWAYS AS (total_amount - amount_paid) STORED`. Postgres refuses the assignment
(SQLSTATE 428C9) before looking at any row, so the `supplier_invoice` branch of this route can
never reach its own subledger write. `bank-match-confirm.ts` is the only file in `src/` or
`pages/` that writes this column.

**Evidence (executed).** `tests/integration/k074-bank-match-confirm-supplier-balance.int.test.ts`
— 1 test, **1 failed**, real PostgreSQL fixture, running the route's UPDATE verbatim against a
seeded bill: `error: column "balance" can only be updated to DEFAULT`. Output: `red.log`. The
test exercises the statement, not the whole handler.

**What actually happens in production today.** Because 428C9 is a SQL error, the request
transaction aborts and the COMMIT that `withAuth` issues is answered by Postgres with a
ROLLBACK. So the supplier-invoice branch does not corrupt the ledger — it simply fails, every
time, with a 400 carrying a Postgres message. The customer-invoice branch (`:164`) and the
purchase-order branch (`:202`) do not touch a generated column and do succeed; their exposure is
the ordering defect alone, which needs a non-SQL throw after the first write to bite.

**Proposed minimal fix.** Two lines. Drop `balance = ${newBalance}::NUMERIC,` from the UPDATE at
`:121-122` (the column is computed) and change the catch at `:269` to return
`apiResponse.internalError` — or rethrow to `withErrorHandler` — so a failure after the first
write rolls the request back instead of committing it.

**Historical-data impact.** None from the supplier branch: `balance` has been generated since the
table was created, so a manual supplier-invoice bank match has never succeeded and no partial
row exists. Detection SQL is unnecessary — the absence is the evidence. Operationally, users
have been unable to confirm supplier-invoice matches from the FindMatchModal for the life of
this route.

**Risks.** Removing the `balance` assignment changes nothing arithmetically: the generated
expression already yields `total_amount - amount_paid`. Returning 500 instead of 400 makes the
failure visible to `withAuth` and to error tracking, which is the point.
