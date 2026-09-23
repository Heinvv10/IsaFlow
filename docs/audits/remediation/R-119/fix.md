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
-- NaN as well as negatives: `NaN < 0` is FALSE, so a sign-only census does
-- not find a NaN row, and NaN was reachable before this fix.
SELECT company_id, count(*) FROM customer_invoices
 WHERE total_amount < 0 OR subtotal < 0 OR tax_amount < 0
    OR total_amount = 'NaN' OR subtotal = 'NaN' OR tax_amount = 'NaN' GROUP BY 1;
SELECT company_id, count(*) FROM supplier_invoices
 WHERE total_amount < 0 OR subtotal < 0 OR tax_amount < 0
    OR total_amount = 'NaN' OR subtotal = 'NaN' OR tax_amount = 'NaN' GROUP BY 1;
-- and, for those rows, whether any carry a journal — a posted one is a
-- journal-reversal exercise, not a data edit:
SELECT count(*) FROM customer_invoices
 WHERE (total_amount < 0 OR total_amount = 'NaN') AND gl_journal_entry_id IS NOT NULL;
SELECT count(*) FROM supplier_invoices
 WHERE (total_amount < 0 OR total_amount = 'NaN') AND gl_journal_entry_id IS NOT NULL;
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


## Review round 2 — the legs

Asked the adversarial reviewer whether NaN could also enter through `subtotal` or `tax_amount`. It could, and so could a NEGATIVE leg, which round 1 did not close:

| Finding | Fix | Proof |
|---|---|---|
| **MEDIUM: the guard covered `total_amount` only.** A row can carry `subtotal -1000, tax -150, total 115`. The total reads clean, so a total-only guard *hides* the damage from anyone checking totals, while `SUM(subtotal)` and `SUM(tax_amount)` — the VAT return and every sales-analysis report — go wrong. Reachable by the same opaque-`templateData` path, because `headerTotals` compares stored legs against derived ones only when the template HAS lines, and production carries line-less templates. | The trigger refuses a newly-negative `subtotal` and `tax_amount` with their own messages, on the same "changed" semantics so legacy rows stay correctable. NaN on the legs was already closed in round 1. | Reproduced in psql first (`negative legs accepted: subtotal=-1000.00 tax=-150.00 total=115.00`), then two tests; mutations M12 and M13 red. |
| LOW: the Sage importer marks a staged credit note `'failed'`, which is indistinguishable from a genuine failure and unfindable by a later credit-note import. | Not changed — the function is unreachable (R-101) and inventing a status nobody reads would be speculative. Recorded on R-101 instead, so whoever revives that importer handles credit notes deliberately. | — |

**Regression after the leg guard:** the same 171-file sweep — 151 passed, 987 tests, the same 4 failures that fail identically on master. Zero failures mention the trigger.


## Review round 3 — all findings fixed

| Finding | Fix | Proof |
|---|---|---|
| **MEDIUM (adversarial): round 2 put the LEGS under the trigger without giving the AI capture pipeline the matching validator line**, so the highest-volume automated writer now reached the raw trigger. Both routes write `subtotal = totalAmount − vatAmount` and `tax_amount = vatAmount`; an extractor reading a VAT-inclusive figure as the VAT (`vatAmount > totalAmount`) makes the subtotal negative, and a negative `vatAmount` makes the tax leg negative. Nothing catches 23514, so a bad scan was a 500 and a paged engineer. | `validatePipelineInput` refuses a non-finite or negative `vatAmount` and one exceeding the total, on the branch that already answers 400 with the errors. | 4 unit cases, including the accept case; the same defect class as round 1's masked 500, one layer down. |
| **MEDIUM (general): the take-on guard shipped with no test** — deleting it from either importer left the suites green, the row reaching migration 692 and being reported with the raw trigger message instead of the file row and the remedy. | A parameterised case per importer (negative and NaN): refused by file row, remedy named, `createJournalEntry` never called, no INSERT issued. | `migrationImportService.test.ts` and `migrationApService.test.ts`. |
| **LOW-MEDIUM (adversarial): the census query misses NaN rows** (`NaN < 0` is FALSE), and NaN was reachable before this fix — so prod may hold rows nobody would look for. | The census in this file and in the register for R-119 and R-117 now tests NaN and the legs too. | — |
| **LOW (adversarial): the NaN arm has no "unchanged" exemption**, so a legacy NaN row cannot be repaired one column at a time. | Deliberate, now documented in the migration: a column still holding NaN poisons every SUM, so a repair sets all three in one statement. Cancelling works either way. | The reviewer's own probe: cancel OK, repair-total-only refused, repair-all-three OK. |
| **LOW: `deriveSageVat` with stated figures can return `taxAmount = total − subtotal < 0`**, which the leg arms now refuse. | Recorded on R-101, since that importer is the only caller that can reach the branch and is dead until R-101 lands. | — |

The general reviewer also confirmed the take-on guard's SHAPE was the right call: refusing and naming the row beats translating a negative open item into a `credit_notes` row the file never supplied a number, approval state or application target for.


## Review round 4 — the last leg writer

| Finding | Fix | Proof |
|---|---|---|
| **MEDIUM (adversarial): `createDraftCustomerInvoice` takes `taxRate` off the request body and never validates it** — the main customer-invoice create route. `{"taxRate": -50}` gives `subtotal 1000, tax_amount -500, total_amount 500`: the total reads clean, so neither a total guard nor 692's total arm sees it, while the VAT return and the output-VAT GL leg go negative. **This PR is what changes its behaviour**: before 692 it silently wrote the bad leg; after 692 it 500s through the route's hand-rolled `CREATE_FAILED` and pages someone. The same defect fixed at `time-entries-invoice.ts` in round 1, on the higher-traffic route. | The rate must be finite and within 0–100, thrown as `InvoiceLineValidationError` — the file's existing idiom, which the route already maps to 400 — beside the line guards the July-4 audit added. The MCP twins already clamp `tax_rate` at the schema. | `tests/unit/services/ar/customerInvoiceCreateTaxRate.test.ts`: negative, over-100 and NaN refused with nothing written; 0, 15, 100 and unset pass the guard. Removing the guard turns all three refusal cases red. |
| LOW (adversarial): the practice WIP route masks the underlying message via `badRequestFromError`, so a refused WIP invoice says "WIP invoice failed" with nothing to act on. No data risk — the write is inside a savepoint. | Registered as R-120, not fixed here. | — |
| LOW (general): `deriveSageVat` with stated figures can return a negative tax leg, and both Sage importers guard the total only. | Registered on R-101 — the AR importer is dead until then, and the AP one calls it in the both-unstated branch, so no live path reaches it. | — |

**Round 4 residual, closed rather than registered:** the take-on guard checked the total only, and the drift check beside it is `|subtotal + tax − total|`, which a SWAPPED leg satisfies exactly — `subtotal 1200, tax −200, total 1000` passed both and reached 692's leg arm with a raw message. The guard now covers all three figures on both importers, with a case per side; removing the leg arm goes red.

Four rounds, and the shape repeated each time: **every guard I added moved the failure one layer down**, from the total to NaN, to the legs, to the writers that compute a leg from an unvalidated rate. The reviewers found each one; three of the four were consequences of my own previous round.
