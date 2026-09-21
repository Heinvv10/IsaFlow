# K-144 — matchTransaction stamps an unvalidated journal line id

**Claim.** "The line id from the request is written with no ownership or journal check."

**Disposition: confirmed** (exactly as claimed).

**Evidence.**
- `matchTransaction` (`src/modules/accounting/services/bank/bankTxStatusMutations.ts:69-94`,
  origin/master) writes `matched_journal_line_id = ${journalLineId}::UUID` straight from its
  argument. `lockForStatusWrite` above it checks only the BANK row's own status.
- Reachable unvalidated from two routes: `pages/api/accounting/bank-transactions-action.ts:90`
  (`journalLineId` is Zod-checked as a UUID only, schema line 31) and
  `pages/api/accounting/bank-match-confirm.ts:260` — the `journal_line` arm calls straight through,
  unlike the `bank_transfer` arm above it, which DOES look the line up company-scoped first
  (line 214). That asymmetry inside one file is the strongest evidence the check was intended.
- The FK to `gl_journal_lines(id)` is not a tenant check: referential integrity is not subject to
  RLS. Verified against the fixture schema (`bank_transactions_matched_journal_line_id_fkey`, and
  FORCE row security with `tenant_isolation` on `gl_journal_lines`).
- RED: `tests/integration/k144-match-unvalidated-journal-line.int.test.ts` — 3 failed of 3.
  A line from another company is accepted and the row is left `matched` against a line no query in
  this company can resolve; a non-existent id surfaces as a raw FK violation
  (`violates foreign key constraint …`) rather than a clean 400, which also poisons the request
  transaction; and one line can be bound to two bank transactions. Log: `red.log`.

**Proposed minimal fix.** In `matchTransaction`, before the UPDATE:
`SELECT 1 FROM gl_journal_lines WHERE id = ${journalLineId}::UUID AND company_id = ${companyId}::UUID`
→ throw `Journal line ${id} not found` when empty. Do the same for `reconciliationId` against
`bank_reconciliations`. Whether one line may serve two bank transactions is a separate policy call —
raise it with K-019/K-020 rather than deciding it here.

**Historical-data impact.** Rows may exist. Read-only census, as superuser (RLS would hide exactly
the rows sought):
`SELECT bt.id, bt.company_id, jl.company_id AS line_company FROM bank_transactions bt
 JOIN gl_journal_lines jl ON jl.id = bt.matched_journal_line_id
 WHERE jl.company_id <> bt.company_id;`
and for double binding:
`SELECT matched_journal_line_id, COUNT(*) FROM bank_transactions
 WHERE matched_journal_line_id IS NOT NULL GROUP BY 1 HAVING COUNT(*) > 1;`
Either hit corrupts the reconciled balance for that account.

**Risks.** Low. The added lookup is indexed. Any caller currently relying on matching a line it does
not own is already producing a broken row.
