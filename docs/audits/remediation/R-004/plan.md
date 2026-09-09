# R-004 correction plan

Baseline d51015f4 (ebeac9ca + K-008). Both guards accept scalar SQL-executing functions: relation discovery cannot see the string argument of `query_to_xml('SELECT secret FROM webhook_endpoints …')` and the scope guard passes a SELECT with no FROM. Real PostgreSQL API reproduction is required before the fix, because the preserved probe proved guard acceptance only.

Add an AST function-capability gate (`nlQueryFunctions.ts`): every `call` node must be unqualified and its name must be in an explicit analytical allowlist (aggregates, window, math, null-handling, string, date/time, `any`/`all`/`some`/`exists`). Any schema-qualified call or unknown function is rejected. `extract`, `substring`, `overlay`, `cast`, `case` node forms are pure expressions and stay allowed. The gate runs inside `validateGeneratedSQL` after relation validation, so the API contract ("Query rejected" envelope) is unchanged.

Regression: unit coverage of accepted analytical calls and rejected `query_to_xml`, `table_to_xml`, `xpath`, `lo_get`, `public.`-qualified and quoted names; real PostgreSQL authenticated API test proving the secret is no longer returned and an aggregate query still works. No schema or historical-data changes; rollback is the prior release. Production RLS impact remains unverified and is recorded as such.
