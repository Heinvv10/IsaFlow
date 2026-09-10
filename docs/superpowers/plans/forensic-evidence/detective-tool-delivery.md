# Remaining Phase 3 detective tool delivery

Base: 179063525. Owner: root. No migrations. Registry integration centrally owned.

Validated gap: shared three-way, journal, statement and payroll detectors exist, but only duplicate/payment tools are discoverable. This task exposes existing accounting truth, then verifies actual current-authority refusal and missing-source semantics; it does not waive the remaining large asynchronous population work.

Owned files: src/lib/mcp/tools/forensicRiskChecks.ts (reuse one bounded adapter), src/lib/mcp/tools/forensicOperationalChecks.ts (four descriptive definitions); tests/unit/mcp/forensic/operationalCheckTools.test.ts. Central discovery/client/metering/generated census and affected exhaustive fixtures follow independently reviewed source.

Failing tests first: missing four definitions; invalid limit/cursor/date/unknown fields must never obtain context or call shared services; correct input must pass the issued context, preserve complete result including unknown coverage, totals and next cursor; shared permission errors propagate. Input cannot select a company. Reads never request posting/idempotency or mutate findings.

Acceptance: focused RED then GREEN; named independent review; focused real PostgreSQL detector and actual MCP HTTP exercises under serialized lease; registry/discovery and all-tool contract fixtures updated with source integration. Domain permissions must be enforced by real services, including current payroll rights. No claim of complete population coverage above admitted source bounds.

## Verification and review

- Genuine missing-module RED at5d0647b2c; shared adapterf6fa4c479 passed26focused tests and snapshot independent named review.
- Discovery450e25955 produced4RED; central registration0a25d9455 and exhaustive census updates passed394tests7files. Snapshot independent comparison confirmed all148 prior tool declarations unchanged and exactly4 new reads (152/84/68/32).
- Independent exception review2779c730e found setup-failure resource leak. Two genuine lifecycleREDs0e9212d41 corrected93e14c88a;2GREEN and named re-review clean. No secret-scan bypass: rejected credential-shaped synthetic URL replaced with credential-free mock.
- Actual35291:33 existing three-way/journal-bank/payroll PostgreSQL checks passed, initial HTTP fixture2fail/4pass. Wrong fixture assumptions corrected: bank population includes2 account observations despite missing statements; invoice permissions map to customers AND suppliers, not module invoices. Added independent current deny for each domain.29897 then6pass/1failure for wrong missing-source reason. Final69114 all7 actual MCP HTTP tests PASS15.39s with actual PAT/default registry/current domain checks, one backdated source journal, foreign tenant isolation and missing independent statement/settlement evidence. All fixture pools/servers closed. Logs siblingartifacts operational-detective-pg-http.log and operational-detective-http-final.log.
- Source/dedicated test TS93988 pending at this checkpoint. Actual MCP tests use Next apiResolver over a real local socket; final integrated built Next proof remains separate. Other domains' nonempty true/negative cases are the33 shared PostgreSQL tests, not a claim of nonempty four-domain HTTP workflows.
- Final source and dedicated owned-test TypeScript93988 terminal0; full-rule source plus dedicated typed-test ESLint44549 terminal0, zero warnings/errors. No full CI rerun claimed. Current source and tests ready for final named integration review.
