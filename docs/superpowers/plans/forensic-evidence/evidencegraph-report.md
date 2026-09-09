# Shared transaction evidence reader

Base: `d6d8b48f`. Owned branch: `feat/mcp-forensic-transaction-evidence-20260909`.

## Implemented contract

`inspectTransactionEvidence(ctx, {entityType, entityId, cursor?, limit?})` returns safe identity/status/version/hash-availability nodes, recorded undirected association edges, coverage gaps and an optional cursor. It requires a live branded `ControlTx` and reloads effective current permissions before traversal. Missing, inaccessible and foreign roots share `EVIDENCE_UNAVAILABLE`. Inaccessible neighbor identities never appear in results. No names, amounts, descriptions, account numbers, document URLs, bytes, actual hashes, approval binding payloads or protected evidence are returned.

Supported roots include supplier, native/Sage supplier invoice, supplier payment, bank transaction, journal, operation approval, captured/procurement/bank-attachment document, customer invoice/payment, credit note, purchase order and goods-received note. Each loaded endpoint is company-owned and separately scope checked. Procurement documents have no company column: ownership follows the original persisted typed parent, independently of cross-links. The existing `supplier_invoice` procurement discriminator means Sage. An unrelated same-UUID native invoice cannot establish ownership. Native invoice procurement provenance remains explicitly unsupported; native captured-document evidence works.

Recorded association families: supplier invoice/payment/PO/credit records; supplier payment allocations; invoice/payment posting journal pointers; bank matched journal lines and transfer journal pointers; journal reversal pointers; approval subject; PO/GRN; captured matched invoice/bank pointers and native invoice/customer invoice/journal source-document pointers; procurement original parents/cross-links; bank attachments. Relationships are associations, not claims that historical approval or payment execution was valid.

## Coverage and bounds

SQL relationship pages contain at most 100 links; document/domain streams retain their separate exact totals. Result node and edge pages each have at most `limit` items, default 50, maximum 100. Traversal stops at depth 6, 500 nodes, 2,000 edges or 2,000 helper reads, with explicit partial coverage. Counts describe the visited population only. Depth-limit nodes conservatively mark partial even if their remaining relationships might be empty.

`complete` concerns the supported bounded current graph, never a historical audit assurance. Missing versions/events remain untracked. `recorded_since` uses the earliest actual persisted event timestamp among visited versioned entities. Missing document bytes/hashes remain explicit. Absent associations are not invented using dates, amounts or text. Native procurement ambiguity is an explicit partial-coverage gap.

A cursor contains tenant/root, deterministic graph digest and offset. Every page rebuilds the graph under current permissions and validates the binding/digest; no client counts or identities are trusted. Concurrent graph changes invalidate subsequent cursors. This is a current read-committed graph, not a historical MVCC snapshot across calls.

## Executed verification

Node 22.23.1. Initial five behavior tests failed because the implementation module did not exist (RED); implementation then made all five pass. Two additional adversarial units cover 500-node truncation and malformed/unsupported persisted targets. Final units: **7 passed**, 1.00 s.

Synthetic PostgreSQL only, exclusive fixture lease: `localhost:33149/isaflow_schema_fixture`, validated via `fixtureConfigFromEnv`/`validateFixtureTarget`/`provisionForensicFixture`. Real `withControlRequest`, branded context, `SET LOCAL ROLE app_user`, live effective permissions and database queries; no query/auth mocks. Final integration: **7 passed**, 12.74 s (tests 11.95 s). Pools closed and lease released.

Executed cases:

- Bank → journal → supplier payment → invoice and approval, including captured invoice document, payment procurement document and bank attachment; no sensitive fixture strings returned.
- Foreign and nonexistent roots return identical refusal.
- Current PAT scope reduction prevents journal/invoice neighbor discovery while preserving authorized bank attachments.
- Foreign Sage procurement parent plus colliding own native invoice UUID and malicious own-payment cross-link cannot confer document authority.
- 120 attachments traverse across SQL and result pages with exact 121-node population, no duplicate result nodes, and stale-cursor refusal after change.
- Persisted reversal edge/status remains visible with untracked historical version.
- Dangling captured parent produces an explicit unknown gap without exposing its UUID.

Commands (fixture environment supplied separately):

```sh
node node_modules/vitest/vitest.mjs run tests/unit/services/controls/transactionEvidence.test.ts
node node_modules/vitest/vitest.mjs run --config vitest.integration.config.ts tests/integration/controls/transactionEvidence.int.test.ts
node node_modules/typescript/bin/tsc --noEmit --pretty false
node node_modules/eslint/bin/eslint.js src/modules/accounting/services/controls/transactionEvidence*.ts tests/unit/services/controls/transactionEvidence*.test.ts tests/integration/controls/transactionEvidence.int.test.ts
```

TypeScript and focused source lint clean. Including the two new test files in the lint command encounters the repository project-service exclusion (`was not found by the project service`); those tests are executed by Vitest, and no test-lint success is claimed. No CI/build, deploy, production data or external communication. Initial/final local logs: `/tmp/evidencegraph-unit.log`, `/tmp/evidencegraph-pg.log`, `/tmp/evidencegraph-pg7.log`, `/tmp/evidencegraph-ts.log`, `/tmp/evidencegraph-lint.log`, `/tmp/evidencegraph-source-lint.log`.

## Integration boundaries

Root owns tool/registry/UI registration and any new document provenance schema. This commit adds no transport endpoint or generic protected-data reveal. Employee/payroll evidence roots are deliberately unsupported. Approval subjects, stored source-version identities and decision evidence refs are traversed. Decision documents additionally require exact recorded subject and actual persisted parent agreement; source references are historical intent associations, not a claim that their current version still matches the approval. Historic deleted links/records cannot be reconstructed from current parent pointers. A future typed procurement provenance discriminator is needed before native procurement invoice links can be supported safely. No programme-wide completeness claim is made.


## Review correction and approval-reference completion

The first reversal fixture used obsolete `status=reversed` and masked the actual writer behavior. Shared `reverseJournalEntry` preserves `posted` and sets `reversed_at`. A focused unit failed before the fix; a real shared post/reverse PostgreSQL test also failed with the old status-only flag condition (`expected [] to include reversed`) and passes with the safe `reversed_at IS NOT NULL` projection. Cancellation alone no longer invents a reversal flag (unit RED then GREEN). One intermediate PG run correctly rejected an unbalanced legacy fixture when its status changed to posted; the fixture was balanced before final proof.

The graph now expands persisted approval source-version identities, including GL account, fiscal-period and company-settings metadata under read:reports. It also expands decision evidence in captured, procurement and attachment stores only after exact subject/parent validation. Captured evidence may follow actual same-supplier payment allocations; procurement remains strictly typed to the legacy Sage convention. Unsupported, mismatched, missing-byte/hash assertions or invalid decision refs create source-only coverage gaps, with no rejected document IDs emitted. Raw hashes/fingerprints never enter the result. Deterministic ordering is explicit in SQL aggregation as well as result/cursor ordering.

The authorized narrow `approvalQueries.validateApprovalEvidence` fix refuses native supplier-invoice procurement evidence until typed native provenance exists. Actual RLS in migration 497 already blocks the tested native-A/Sage-B collision: this is **not a reproduced cross-tenant disclosure**. A same-tenant native/Sage collision did reproduce incorrect approval evidence acceptance (promise resolved instead of rejecting) before the fix. The final tests preserve cross-tenant refusal without depending on new wording and enforce explicit unsupported native-parent refusal for the same-tenant case. Existing unambiguous supplier-payment validation remains supported.

Final executed verification after these changes:

- **33 units passed**, six graph and existing operation-approval suites.
- **11 PostgreSQL tests passed**, 46.50 s total / 45.87 s tests, including real shared post/reverse, recorded event history, exact approval parent validation, inaccessible source references and both collision cases.
- TypeScript and focused source ESLint passed. Existing test-file ESLint project-service limitation remains unchanged.
- No fixture schema changes. Pools closed and DB lease released after final run.

Additional local proof logs: `/tmp/evidencegraph-reversal-red.log`, `/tmp/evidencegraph-reversal-pg-red.log`, `/tmp/evidencegraph-procurement-pg-red2.log`, `/tmp/evidencegraph-review-pg-green.log`, `/tmp/evidencegraph-review-unit-green.log`, `/tmp/evidencegraph-review-ts.log`, `/tmp/evidencegraph-review-lint.log`. The first foreign-only PG RED was an error-wording mismatch, not a bypass; only the subsequent same-tenant case establishes wrong-parent acceptance.

The separately assigned customer-family completion follows below. No programme-wide completion claim is made.


## Customer-family completion

Added exact stored `customer_payment_allocations` associations with both payment and invoice company ownership, customer invoice/payment posting-journal pointers, customer credit-note invoice links and credit-note posting-journal pointers. These reuse the authorized document and reversal traversal. No AR financial writer or state transition changed. Safe `confirmed` payment and `applied` credit-note lifecycle labels are retained rather than collapsed to unknown.

Two lifecycle unit cases failed before the allowlist change and passed afterward. Two real PostgreSQL fixtures, starting respectively from customer invoice and customer payment, initially returned only each root and its directly attached document. After the relationship additions both traverse invoice, payment, customer credit note, all three posting journals, a persisted reversal, matched bank transaction, three separately filed procurement documents and captured journal evidence. Both prove foreign-root refusal and no sensitive payload output. Complete coverage in these fixtures describes their current recorded graph, not historical assurance.

Customer RED/GREEN logs: `/tmp/evidencegraph-customer-unit-red.log`, `/tmp/evidencegraph-customer-unit-green.log`, `/tmp/evidencegraph-customer-pg-red.log`, `/tmp/evidencegraph-customer-pg-green.log`. Final focused units: **35 passed** across six graph/approval suites. TypeScript and source lint clean; test-file lint exclusion unchanged. Final full PostgreSQL suite: **13 passed**, 35.71 s total / 35.06 s tests. Pools closed and DB lease released. Full proof: `/tmp/evidencegraph-customer-full-pg.log`, `/tmp/evidencegraph-customer-unit-full.log`, `/tmp/evidencegraph-customer-ts.log`, `/tmp/evidencegraph-customer-lint.log`.
