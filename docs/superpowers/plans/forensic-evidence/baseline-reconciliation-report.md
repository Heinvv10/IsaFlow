# Named baseline reconciliation

Read-only code review: original `f57f71a75aa0c8ff2a0202c4b2c65d20f0de510e`, upstream `0f16391e021eecbb9f2ab75a11168e92fb8cc642`, integration `3360b532`. Their merge base is exactly the original SHA. No merge, checkout mutation, database or CI run was performed; only this report is committed in the worker branch.

## Integration risks

The intersection of changed paths from the common baseline contains exactly three files:

| File | Upstream change | Preserve/resolve |
|---|---|---|
| `services/ap/supplierInvoiceWorkflowService.ts` | `aea77e85`, K014: lock bill before standalone post's check for existing journal | Keep controlled integration implementation, current-authority checks, canonical approve/post aliases, retained original JE, exact account/currency binding. Confirm preflight lock/no duplicate GL semantics survive. Do not restore upstream unguarded writer wholesale. |
| `pages/api/accounting/supplier-invoices-bulk-action.ts` | `64f3d09e` and `2a0d6d12`: per-item savepoint and fatal `txUnusable` check | Port savepoint/fatal check while retaining integration's per-entity `approvalIds` forwarding. Do not reset mandatory control-integrity failure to manufacture partial success. |
| `services/gl/journalEntryPostingService.ts` | `99733151`: preserve BU through reversal | Integration already copies `bu_id` directly with project/cost-centre/VAT fields. Retain kernel, exact decimal INSERT/SELECT and generated permits. Upstream's matching `mapLineRow.buId` and `JournalLine.buId` additions in CRUD/types are still useful and do not overlap. |

Service paths above are under `src/modules/accounting/`. There are also semantic interactions in cleanly merging files, especially VAT source queries and new recurring invoice posting.

Recommend a single merge of the exact upstream SHA into a fresh integration checkpoint, retaining upstream commit ancestry rather than individually replaying the many intertwined merge commits. Resolve the three overlaps explicitly as above, inspect the complete staged diff, then rerun focused real PostgreSQL upstream and forensic suites before full integration CI. Never choose an entire upstream AP/GL writer over the new control implementation merely to resolve a conflict.

## VAT: fixed pairing does not enforce filed-period immutability

`c76280e5` first suppressed a cancelled source and its contra indiscriminately. `58c300cb` corrected the period logic: a posted contra outside the queried period keeps the original visible; a same-period pair is suppressed together; recursion handles reversal descendants. `3a4156c9` restricts both branches to posted journals, avoiding draft reversal effects. Use the final upstream query, not the first commit alone.

Named final evidence: `0f16391e:src/modules/accounting/services/reports/vatBoxBasisQuery.ts`, cancelled_entries_base and recursive cancelled_entries (roughly lines99–145). `docs/audits/remediation/K-032/fix.md` explicitly limits its tested scope to credit notes because upstream invoice cancellation clears the original journal FK. Integration AP cancellation instead intentionally retains that FK (`3360b532:.../ap/supplierInvoiceWorkflowService.ts`, final UPDATE). The merged query will consequently also affect real AP cancellation. Re-run actual AP cancellation, not fabricated cancelled-invoice rows.

**Confirmed remaining source-level gap:** filed/locked VAT can still change when its fiscal period remains open. Integration GL material chooses the original date for an open fiscal period (`3360b532:.../controls/glOperationMaterializer.ts:65`); its posting guards check fiscal status, company lockdown and active accounts but never `vat_period_locks` (`.../gl/journalEntryPostingService.ts:37`). Upstream's reversal date/posting path likewise has no VAT lock check. A backdated AP cancellation therefore posts its contra into the original filed VAT period; same-period pair suppression can remove the original's tax/base from the regenerated return. Pairing fixes reporting arithmetic, not write authorization.

Required acceptance after merge: (1) original August invoice + September contra preserves August filed tax/base and takes September correction; (2) VAT-locked August with fiscal period open refuses same-August cancellation/contra before effects; (3) explicitly authorized later correction freezes and binds target period/date; (4) original/contra/reversal-of-reversal, draft descendant and cross-tenant cases; (5) saved VAT figures and current re-derivation agree or expose an explicit immutable historical snapshot/difference. Root's pending VAT posting closure remains necessary.

## Other upstream fixes and changed acceptance

- **No payroll service/ETI/payroll-loan recalculation fix landed in this delta.** K030 (`1e41ba30`, `c51b7bb9`, `1257632e`, `f89bf20b`) changes `services/loans/loanScheduleService.ts` and new `loanScheduleInputs.ts`: loan financial terms/events/rate points/ENGINE_VERSION enter cache identity; newest persisted run and atomic schedule persistence are maintained. This is the accounting loans module, not payroll loans. Keep payroll ETI and payroll loan recalculation gaps separately recorded.
- Payroll K024/R005 (`1efb0959`, `be5b1a64`, `89024a8c`) restrict IRP5/EMP501/year-end routes to approved/paid declarable runs and align reconciliation. These improve annual export consistency; they do not certify payroll calculation or statutory eligibility.
- K013 (`1ef8c82e`, `1c39bf80`, `dc2aaf76`) makes recurring invoices persist lines, post GL and serialize/idempotently run a template inside a savepoint. This creates an additional important AR financial ingress for forthcoming shared-writer enforcement; old 'header only' assumptions are obsolete.
- K016/K017 (`87bee9d7`, `e0b1aab1`, `f82f9e88`, `30b0e8af`, `3dc5f63b`) remove VAT from supplier/customer gross settlements and bank transfers consistently across service/rule/UI/MCP paths, with explicit settlement coercion warnings. Detector fixtures must distinguish invoice VAT from settlement cash; do not claim a duplicate VAT defect is still unfixed here.
- K021 (`74c6c32c`, `480e2060`) savepoints/preflights keep refused reversals from committing subledger unwind, including payment void paths. Preserve these around forthcoming domain-control integration.
- K019 (`c4fe0f70`, `1a33abb5`, `1d002aaa`, `fe21320e`) enforces one bank line per GL movement in transfer link passes and returns import-link warnings. K020 (`89bd6ae9`, `3f1702b6`, `146990a4`, `2ff1617e`) corrects reconciliation balance derivation and refuses adjustments that cannot move that balance.
- K018 (`ef5ad06e`, `473cc573`) refuses unsupported open-banking providers instead of fabricating transactions, persisting/returning the refusal. Synthetic provider results must no longer be treated as an active source defect.
- R004 (`b3b4a71d`, `6c63df7d`, `fcf3e4ca`) hardens NL query function allowlisting, global-reference scope traversal and dangerous casts/role keywords. Keep these with the new control read surfaces.
- No new registered MCP tool names appear in this delta. Existing `allocationVatGuard.ts` and `bulkAllocationPost.ts` change semantics, and recurring/bank API routes change behavior.

Only new migration: `623_gl_je_reversal_of_index.sql` (`58c300cb`), an idempotent partial index on gl_journal_entries(reversal_of_id). It does not collide with root626+ reservations. Its ordinary transactional index creation takes a table SHARE lock; apply in the serialized fixture/deployment migration window. Existing root fixture having626+ does not mean623 has been applied.

Proof boundary: upstream committed audit logs report their prior CI/PG runs; this review did not rerun or independently certify those results. The merged control context may require adapting old test request harnesses to authenticated withControlRequest; preserve adversarial assertions instead of disabling guards.
