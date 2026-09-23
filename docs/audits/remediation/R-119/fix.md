# R-119: a negative-total invoice is refused

## Defect
Nothing restricted the sign of `total_amount` on `customer_invoices` or `supplier_invoices` — no CHECK, no trigger, verified against the schema fixture — and a census of the INSERT sites found **six** writers with no guard of their own (my first pass named four; the blind reviewer found the two take-on importers I had missed):

| Writer | Why it was open |
|---|---|
| Recurring template **execution** (`recurringTemplateLines.ts` → `recurringTransactionInvoices.ts`) | `templateData` is opaque JSON off the request body; the create-time `quantity > 0 / unitPrice >= 0` guard does not re-run, does not cover AP templates, and does not cover a line-less template's stored `totalAmount`. |
| AI capture pipeline (`ai-invoice-pipeline.ts`, `capture/[id]/post.ts`) | `validatePipelineInput` tested null/undefined only. |
| Time-entry billing (`time-entries-invoice.ts`) | Neither the invoice build nor `createTimeEntry` guards hours or rate. |
| Sage AR import (`sageCustomerImportService.ts`) | Skipped `=== 0`, not `< 0`, where its AP sibling guards `> 0`. |
| AR take-on import (`migrationImportService.ts`) | Validated `subtotal + tax ≈ total` drift only, never the sign. |
| AP take-on import (`migrationApService.ts`) | The same, AP side. |

A negative-total invoice is an ad-hoc credit note living outside `credit_notes`: the ageing and the subledger filter `balance > 0` and never show it, while its journal — once posted — stands in the GL. `credit_notes` already serves **both** sides (`type` is `'customer'` or `'supplier'`), so refusing the shape costs no capability.

## Decision
Hein's call: **refuse at source, both sides.** The alternative — teaching the ageing to carry negatives — would make every downstream consumer sign-aware (bucketing, statements, dunning, `reconcile_subledger`, AFS notes, VAT201) to support a shape that duplicates an existing document.

## Fix
- **Migration 692** puts the rule in the database, which is what closes the class: it catches the writer nobody enumerated, the scripts and the next agent.
- **A trigger, not a CHECK** — measured, not assumed: a CHECK is enforced even under `session_replication_role = 'replica'`, so a negative row would become unrepresentable in tests. Rows in exactly that shape are in production now, and `effectivePaidExpr`'s sign-aware clamp (R-117) exists to serve them. A trigger is suppressed by replica mode, so `tests/integration/helpers/preConstraintRow.ts` can still seed a pre-guard row — the same way migration 664's rows are seeded. A trigger also carries a HINT naming the remedy, which a CHECK cannot.
- Existing rows are untouched by construction (a trigger fires on writes), so no NOT VALID/VALIDATE dance is needed and the migration cannot fail on historical data. An UPDATE that leaves an already-negative total alone still passes, so those rows can be corrected, cancelled or converted without dropping the guard.
- **`assertNonNegativeDocumentTotal`** (shared/documentTotalSign.ts) gives the four known paths a message naming the remedy instead of a raw trigger error.

## Evidence
`tests/integration/r119-negative-total-guard.int.test.ts`, real PostgreSQL — 6 of 6.
- The database refuses a negative INSERT on both tables.
- A legacy negative row can be cancelled and corrected to 0, but not moved to another negative.
- The AI pipeline refuses, and still accepts a positive total.
- A recurring template with a negative `templateData` total refuses and writes nothing (invoice count unchanged).
- The Sage AR path is pinned as **unreachable**: `importCustomerInvoices` still dies at 42703 (R-101) before its own guard. The guard is in place so the importer cannot be revived without it; the trigger covers that path meanwhile.

**Mutations** (`mutations.log`), all red: pipeline guard removed, recurring guard removed, the shared helper made a no-op, and — the important one — **migration 692's triggers dropped** (3 tests red).

**Regression:** 171 integration files that touch either invoice table — 151 passed, 977 tests, 4 failed. Those same 4 fail identically on master (`6ceb334d6`) against the same fixture (`admin-rls-bypass`, `k072-draft-claim-release`, `k089-ar-migration-balance-due-column`, `k111-row-count-adjacent`), so they predate this change. The 20 failing FILES are suite-level refusals of the fixture database by `assertNotProductionDb`, also pre-existing.

**Two suites needed converting**, both mine, both seeding negative rows on purpose: `r117-aging-negative-total-clamp` and `r086-migration-validation-future-dated` now use `insertPreConstraintRow`. This is the guard doing its job, and it is why a CHECK was the wrong instrument.

## Fixture provisioning
`insertPreConstraintRow` needs `SET session_replication_role`, which is SUSET-context. The disposable fixture's role (`platform_admin`) lacked it, which is also why `k020-reconciled-balance-recompute` had been failing. Granted on the fixture:
```sql
GRANT SET ON PARAMETER session_replication_role TO platform_admin;  -- PG15+
```
`k020` passes again as a result.

## Still open (deliberately)
- **The existing rows.** Not touched: this change stops new ones. The census queries are below; the disposition (convert to credit notes, or leave) needs the prod numbers, and any row already posted to GL makes it a journal-reversal exercise rather than a data edit.
- **Wrong-signed settlements** (`amount_paid +500` on a −1150 document). `effectivePaidExpr` reports 0 settled for these; an integrity check should name them. Recorded on this item.

```sql
SELECT company_id, count(*), sum(total_amount) FROM customer_invoices WHERE total_amount < 0 GROUP BY 1;
SELECT company_id, count(*), sum(total_amount) FROM supplier_invoices WHERE total_amount < 0 GROUP BY 1;
-- and, for those rows, whether any carry a journal:
SELECT count(*) FROM customer_invoices WHERE total_amount < 0 AND gl_journal_entry_id IS NOT NULL;
SELECT count(*) FROM supplier_invoices WHERE total_amount < 0 AND gl_journal_entry_id IS NOT NULL;
```
Read-only, not run against production by this session.


## Review round 1 (general + adversarial), all findings fixed

| Finding | Fix | Proof |
|---|---|---|
| **HIGH (adversarial): NaN defeats both guards, and is worse than a negative.** `NaN < 0` is FALSE so the sign test passes it; `NaN > 0` is TRUE so it passes the `balance > 0` filter the ageing and subledger use — the row is VISIBLE — and `SUM()` over a column holding one is NaN, so a single row destroys every total for the company. Reachable through the motivating writer: `Number(templateData.totalAmount)` on `{"totalAmount":"abc"}`. | The trigger refuses `= 'NaN'::numeric` on `total_amount`, `subtotal` and `tax_amount`, and fires on UPDATE of any of the three. The helper tests `Number.isFinite(t) && t >= 0`, never a bare sign test, with its own message. | Verified independently in psql (`NaN < 0` f, `NaN > 0` t, `SUM` NaN). Mutations M5 (trigger NaN arm) and M6 (helper weakened back to a sign test) both red. |
| **HIGH (adversarial) / MEDIUM (general): the remedy message never reached the operator.** `NegativeDocumentTotalError` was mapped nowhere, so two of the four paths answered 500 "An unexpected error occurred" and paged someone, for an operator-fixable input. The recurring route's own ladder documents 400 for exactly this pre-write class. | Mapped to 400 on `recurring-transactions-execute` (beside `RecurringTemplateTotalsMismatchError`) and on `time-entries-invoice`. | Route test asserts 400 and the remedy text; mutation M11 red. |
| **MEDIUM (general): the census missed the two take-on importers**, and with 692 in place a take-on file carrying credit notes as negative open items would have every such row refused by a raw trigger message, with no credit-note step to put them in. | Both guard the row themselves and report it by FILE ROW with the remedy named, alongside their existing drift errors. The opening balance is short by those rows until they are loaded as credit notes — which the message says. | `tsc` + the existing per-row error path; both files now carry the guard. |
| **MEDIUM (adversarial): the route hardened here still wrote a negative VAT leg.** `taxRate` came off the body unchecked: `-99` on R1 000 gives `tax_amount -990` with a POSITIVE total, so neither the total guard nor the trigger saw it. | `taxRate` must be finite and within 0–100. | Route test asserts 400; mutation M10 red. |
| **MEDIUM (both): three of the four app guards were unproven.** | Tests added for the AP recurring mint, the time-entry route (through `withAuth`), and a NaN template. The Sage one stays pinned as unreachable (R-101). | Mutations M8, M9 red; M6 red once the NaN writer test existed. |
| **LOW (general): only the INSERT arm of the supplier trigger was exercised.** | A legacy supplier row is seeded and its UPDATE arm asserted. | Mutation M7 (supplier trigger INSERT-only) red. |
| **LOW (general): module docs not updated.** | Entries in `core/.claude.md` and `ap/.claude.md`; mirrors regenerated. | `agent-docs:check` OK. |

Mutations after this round (`mutations.log`), all red: trigger NaN arm, helper NaN check, supplier trigger UPDATE arm, AP recurring guard, time-entry guard, taxRate range, 400 mapping — plus round 1's pipeline guard, recurring guard, helper no-op and dropping the migration entirely.
