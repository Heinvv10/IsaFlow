# R-119: a negative-total invoice is refused

## Defect
Nothing restricted the sign of `total_amount` on `customer_invoices` or `supplier_invoices` — no CHECK, no trigger, verified against the schema fixture — and a census of all 17 INSERT sites found four writers with no guard of their own:

| Writer | Why it was open |
|---|---|
| Recurring template **execution** (`recurringTemplateLines.ts` → `recurringTransactionInvoices.ts`) | `templateData` is opaque JSON off the request body; the create-time `quantity > 0 / unitPrice >= 0` guard does not re-run, does not cover AP templates, and does not cover a line-less template's stored `totalAmount`. |
| AI capture pipeline (`ai-invoice-pipeline.ts`, `capture/[id]/post.ts`) | `validatePipelineInput` tested null/undefined only. |
| Time-entry billing (`time-entries-invoice.ts`) | Neither the invoice build nor `createTimeEntry` guards hours or rate. |
| Sage AR import (`sageCustomerImportService.ts`) | Skipped `=== 0`, not `< 0`, where its AP sibling guards `> 0`. |

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
