# K-038 — fix

**Trigger.** `POST /api/admin/migration/sage-commit`. The mappers compute
`amountPaid = Total - AmountDue`, but `MappedARInvoice`/`MappedAPInvoice` declared no such
field and neither commit wrote it.

**Before / after.** A part-paid Sage invoice (R1,150 total, R650 settled) landed with
`amount_paid = 0`, `balance = 1150` (GENERATED) and `status = 'approved'`, overstating aging,
statements and dunning. Now both commits carry the figure and call the canonical
`recomputeInvoiceStatus` for `paid`/`partially_paid`, `paid_at` and AP's `payment_matched`.
The GL journal is unchanged — full invoice total, still balanced, asserted on both paths.

`settledAtSource()` makes the figure safe for a GENERATED column: a non-finite value (Sage
documents without a numeric `AmountDue` give NaN, and neither the pull nor the commit route
validates the payload) or a negative one is REFUSED and imported as unpaid, because `numeric`
accepts NaN and one such row turns a company's whole sub-ledger sum into NaN. An overpayment
is clamped to the total. Every refusal and material clamp is logged and returned in the new `CommitSummary.warnings`,
which `SageCommitSummary` renders as an expanded disclosure on the import page — the row keeps
no trace of a discarded credit and a re-run cannot recover it, so the operator has to see it
at commit time.
The AP total divergence is fixed at its root. `createSupplierInvoice` re-derived each line's
tax from a 2 dp rate, so a bill at a non-round blended rate stored a total that differed from
Sage's in either direction — 700 / 33.33 stored 733.32, 812.50 / 58.40 stored 870.92 — leaving
the invoice row and the journal posted for that same bill up to R0.44 apart before any payment
was considered. An importer can now pass the source's exact tax and the Sage commit does, so the row, the
journal and Sage agree by construction. The field is deliberately NOT on the public
`SupplierInvoiceItemInput`: it lives on `SupplierInvoiceImportItemInput` and is honoured only
when the input carries `trustSourceTax: true`, which no route copies from a body. An unbounded
client-settable VAT amount is the failure mode that gating prevents —
`pages/api/accounting/supplier-invoices.ts` forwarded request-body line objects verbatim, so
without it any write-access user could have posted `unitPrice 100, taxRate 15, taxAmount 10000`.
That route now whitelists the nine line fields the service reads rather than forwarding the
body, giving two independent guards. Every existing caller is unchanged.
AP additionally derives `amount_paid` from what the source says is still OUTSTANDING
(`stored total − source AmountDue`) rather than carrying its paid figure across, so any future
divergence cannot strand a settled bill at `partially_paid`. Sub-cent excess is treated as
arithmetic dust and clamped silently, so real overpayments are not buried.

**R-001 — period close now FAILS on migrated companies, by design.** Before this commit
`arSubLedgerCheck`/`apSubLedgerCheck` passed only because both sides were equally wrong. Now:
part-paid invoices contribute `total − paid` while the GL control account still carries the
full total, and **fully-paid invoices drop out of the sub-ledger sum entirely** —
`arSubLedgerCheck.ts:36` filters to `('approved','sent','partially_paid','overdue')` and
`apSubLedgerCheck.ts:38` to `('approved','partially_paid')`. Both flip to `fail` past the R100
threshold, and `periodCloseReadinessService.ts:106` rolls that up to an overall `fail`.
Direction: GL AR/AP overstated and GL bank understated by exactly the settled amount, so net
assets are unaffected — only the two line items are misallocated. The AP journal and its own
invoice row now agree to the cent, so nothing in this variance is rounding: a reconciler seeing
a residual is seeing the settled cash, not a recompute artefact. There is no in-repo remedy:
`CommitPayload.pulled` has no opening-balance step and the settled cash arrives only as
`bank_transactions` at `status='imported'` with no GL leg. The fix is an opening-balance step
in `CommitPayload` (or allocating those imported bank rows). **R-001 stays open.**

**Files.** `ap.types.ts` and `supplierInvoiceService.ts` (the importer-only exact-tax field),
`pages/api/accounting/supplier-invoices.ts` (line-field whitelist),
`sageMigrationTypes.ts`, `sageMigrationCommitService.ts`, new
`sageMigrationOrchestrator.ts` (the orchestrator moved verbatim so both files clear the
300-line cap; `sage-commit.ts` and one unit test now import it from there), new
`src/components/admin/SageCommitSummary.tsx` (the result panel lifted out of
`pages/admin/tools/sage-import.tsx` so it can be rendered in a test; the page drops 420 → 397).

**Tests.** 16 integration against real Postgres — validator's RED (1),
`…-payment-balances-adjacent` (14) and `…-ar-journal-unmoved` (1, real
`postCustomerInvoiceToGL`) — plus 5 rendered component tests in
`tests/unit/components/sageCommitSummaryWarnings.test.tsx`. Covers AR fully paid / unpaid /
overpaid-clamped-and-reported / non-finite refused with the company sum still numeric /
negative refused / second tenant untouched / re-run idempotent, and AP part-paid with a
balanced full-total journal / recomputed total below Sage's / above Sage's / part-paid at a
non-round rate / genuine overpayment / fully paid / unpaid. Mutation-checked four times:
reverting the original change takes 6 of 9 red; disabling the non-finite guard, the negative
guard or the AP anchor takes their tests red; re-anchoring AP to the source paid amount takes
3 red; hiding the warnings disclosure takes 3 component tests red. Also 8 unit tests on the exact-tax field, reading the values bound into the INSERT rather than
a mocked row, and 3 route tests proving a client-supplied `taxAmount` never reaches the service
and the importer opt-in is never set from a body. Full unit suite 9402 passed, components 395 passed, `tsc --noEmit`, `eslint` and
`agent-docs:check` clean — `green.log`.

**Migration / rollback.** None. Code-only.

**Historical impact.** Every invoice already imported this way has `amount_paid = 0`. Sage's
`AmountDue` is stored nowhere in IsaFlow, so no query measures the error; an exact figure needs
a re-pull from Sage per company. The `invoice_number` dupe check makes the commit idempotent,
so **re-running the migration will NOT repair an already-migrated row** — the only repair paths
are manual `UPDATE … SET amount_paid` per invoice or deleting and re-importing. Upper bound
only (genuinely unpaid invoices look identical), not run against production:
```sql
SELECT company_id, count(*) AS invoices, sum(total_amount) AS overstated_upper_bound
FROM customer_invoices WHERE amount_paid = 0 AND status = 'approved'
GROUP BY company_id ORDER BY 3 DESC;
```

**Limits.** The guard that treats an absent `amountPaid` as unpaid rather than deriving one is
defence-in-depth and is NOT mutation-proof: with the totals now equal the derivation returns 0
anyway, so removing the guard leaves all 17 integration tests green. It is kept because the
field is optional and the commit route does not validate its body. The import page itself was
not loaded in a browser — the extracted result panel is
covered by a rendered component test, and the page change is the import plus one JSX swap.
`paid_at` on a migrated settlement is the MIGRATION timestamp, not the real
settlement date — `recomputeInvoiceStatus` sets `COALESCE(paid_at, NOW())` and the Sage payload
carries no settlement date, so no better value exists; aging and statement surfaces that date
a settlement will be wrong for migrated rows. Only the two Sage commit paths are touched; no
back-fill. `migrationApService.importAPInvoices` (the CSV wizard) already handled `amountPaid`.
