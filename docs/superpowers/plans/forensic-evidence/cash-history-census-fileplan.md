# Independent historical cash population reconciliation

Base4156b37b7; invoice_evidence owns shared unappliedCashHistory/Query and optional census helper, AR/AP result adapters, focused unit/PG tests. Root owns MCP tools and envelope propagation.

Tests first: dropped detail row versus independent source count refuses; duplicate identity refuses; all four dispositions reconcile (recognized remainder, fully applied, inactive/draft, unresolved). Actual115 cash with undated10 allocation stays explicitly partial. Existing AR/AP accounting-date application/inverse/cancellation, tenant and page-money assertions preserved. Add actual independent SQL count and deliberate detail omission plus soft-deleted party coverage.

Query contract becomes {rows,populationCount}. Independent COUNT reads original owned payment tables at cutoff within the same SQL statement as historical details, not from detail/attribution CTE. Singleton census LEFT JOIN details preserves empty population. Analyzer requires count, refuses invalid/missing/duplicate detail population, then reconciles all dispositions. historyCoverage.population records sourceCount/analyzedCount and disposition counts. Existing eligible-universe claim becomes optional and absent: no independently verified eligible-remainder count exists, and rows.length must not masquerade as one. Completeness status concerns explicit evidence plus reconciled original population, not omission of universe alone. Monetary recognition/inverse dates unchanged. Root must expose historyCoverage in MCP.

Verification pending: true RED, implementation, units/real PG/source TS/lint and independent named review. No production claim.
