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

TypeScript and focused lint clean. No CI/build, deploy, production data or external communication. Initial/final local logs: `/tmp/evidencegraph-unit.log`, `/tmp/evidencegraph-pg.log`, `/tmp/evidencegraph-pg7.log`, `/tmp/evidencegraph-ts.log`, `/tmp/evidencegraph-lint.log`.

## Integration boundaries

Root owns tool/registry/UI registration and any new document provenance schema. This commit adds no transport endpoint or generic protected-data reveal. Employee/payroll evidence roots are deliberately unsupported. Approval subjects are traversed; decision JSON evidence refs and approval binding source-version arrays are not expanded by this reader. Historic deleted links/records cannot be reconstructed from current parent pointers. A future typed procurement provenance discriminator is needed before native procurement invoice links can be supported safely. No programme-wide completeness claim is made.
