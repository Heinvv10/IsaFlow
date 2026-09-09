# Independent historical cash population reconciliation

Base4156b37b7; invoice_evidence owns shared unappliedCashHistory/Query and optional census helper, AR/AP result adapters, focused unit/PG tests. Root owns MCP tools and envelope propagation.

Tests first: dropped detail row versus independent source count refuses; duplicate identity refuses; all four dispositions reconcile (recognized remainder, fully applied, inactive/draft, unresolved). Actual115 cash with undated10 allocation stays explicitly partial. Existing AR/AP accounting-date application/inverse/cancellation, tenant and page-money assertions preserved. Add actual independent SQL count and deliberate detail omission plus soft-deleted party coverage.

Query contract becomes {rows,populationCount}. Independent COUNT reads original owned payment tables at cutoff within the same SQL statement as historical details, not from detail/attribution CTE. Singleton census LEFT JOIN details preserves empty population. Analyzer requires count, refuses invalid/missing/duplicate detail population, then reconciles all dispositions. historyCoverage.population records sourceCount/analyzedCount and disposition counts. Existing eligible-universe claim becomes optional and absent: no independently verified eligible-remainder count exists, and rows.length must not masquerade as one. Completeness status concerns explicit evidence plus reconciled original population, not omission of universe alone. Monetary recognition/inverse dates unchanged. Root must expose historyCoverage in MCP.

Verification pending: true RED, implementation, units/real PG/source TS/lint and independent named review. No production claim.

## Actual verification
- Tests-first9277a3983: cash-census-unit-red.log3fail; cash-census-pg-red.log22035 terminal1 with5preserved historical cases passing and2new missing-census cases failing. No economic assertions deleted.
- Final actual7PG12710 terminal0 (cash-census-pg-green.log): original AR/AP as-of inverse/cancellation economics and115/undated10 disclosure preserved, tenant/page checks retained; new independent SQL population comparison + deliberately omitted detail refusal and softdeleted party115 orphan money pass. Fixture pool closed and DB lease released.
- Source TS54561 terminal0; scoped lint2924 terminal0;12focused units across census, historical recognition and vacuousUniverseTotal passed. Logs cash-census-{ts,lint,final-units}.log.
- Existing regex now guards direct customer/supplier base-table COUNT and refuses rows.length universe; independent economic tests provide behavioral evidence. Existing historical unit inputs explicitly supply fixture source count, never production fallback.
- Source count and unique detail identities are reconciled before analysis; all classified dispositions reconcile afterward. Empty tenant produces explicit census0 and no synthetic universe. Query returns details/census from one statement snapshot.
- Independent named review pending. Root owns MCP propagation of coverage and integrated acceptance. This proof checks original source population and disclosed evidence dispositions; it does not claim independent SQL recomputation of eligible remainder amounts. No production verification.
