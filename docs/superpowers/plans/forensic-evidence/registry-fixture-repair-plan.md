# Existing MCP fixture compatibility

Base37d9277e1. Owned four existing tests only: listGlAccountsTool.test.ts, tools-read.test.ts, tools-write.test.ts, toolArgCastGuards.test.ts, plus this plan. No production changes or blanket context/authority mocks.

Focused original run61565 terminal1:6failed/127passed. Inventory assertions expected71read/133total instead of77read/141total. Three existing aging/token-scan paths supplied SQL[] despite the independent cash census returning a singleton row for an empty population. Write credential scan omitted the two new enqueue tool input fixtures and passed undefined.

Correction preserves all existing cast/tenant/credential/economic assertions. Inventory uses77/141. Synthetic SQL boundary recognizes WITH census AS and returns explicit known{id:null,population_count:'0'}; other source mocks remain empty. This is declared synthetic census material, not a query-completeness proof. The actual shared census query has separate PostgreSQL acceptance. Added explicit invalid audit_snapshot and export_audit_evidence inputs so these scan genuine argument-refusal envelopes; successful domain execution needs its separately tested issued context and actual storage. Exact fixture-key equality with all write tool names prevents silently missing new tools.

Final focused run39795 terminal0:133tests across4files pass,1.45s. Logs registry-fixtures-{red,green}.log in shared forensic artifacts. No production source changes, PG or heavy TS run. Existing large test files retain their original scope; no unrelated splits. Root owns reportsAging coverage propagation and integrated proof. Named independent review pending.
