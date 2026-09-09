# Three-way matching fixture compatibility

Base9001f8c99. Own tests/unit/services/ap/performThreeWayMatch.test.ts, new threeWayMatchFixture.ts and this plan. Production service changes are conditional on a demonstrated business defect; none found.

Actual original run: all14 tests failed at missing issued context. Old fixtures mocked the removed invoice-mapper/ordered SQL path. Current service requires current write permission, owned invoice lock, real shared cumulative calculation and evidence disclosure, with atomic cache updates. These are intentional controls, not lost matching functionality.

Replace SQL storage responses using a synthetic PoolClient inside real withControlRequest. Keep actual assertControlTx, effective permission resolver, source SQL builder, source evaluator, Decimal math and cache writer. No blanket authority mocks. Explicit source rows model accepted receipts; legacy supplier PO quantity caches never prove receipt evidence.

Preserved scenarios: exact match, no PO and legacy no PO, price5percent refusal, exact2percent boundary, cumulative qty20percent variance, GRN-covered over-PO invoice, supplier5percent override for4percent price, absent/null2percent defaults, per-line plus parent persistence, exact variance/status and company predicates, missing invoice, empty items. Old no-PO zero-SQL expectation becomes unmatched after permission/owned-lock checks. Added no issued context, revoked viewer, absent GRN, supplier legacy evidence and savepoint rollback checks.

Existing actual PostgreSQL threeWayMatchChecks.int.test.ts covers cumulative accepted receipts/invoices,2percent boundaries, missing/unknown receipt evidence, supplier-family unknown evidence, tenant isolation, revoked permission and rollback of cache writes even when caller catches. No new PG fixture or source change is needed; rerun requires root lease.

Evidence: original focused RED terminal1 all14failed; corrected focused GREEN terminal0 all19passed. Logs in shared forensic artifacts three-way-fixture-{red,green}.log. Repo ESLint default excludes tests from TS project; initial scoped attempt47376 failed parser-project coverage, not code rules. Explicit two-file default-project lint and final PG/sourceTS pending. No production or UI claims.
