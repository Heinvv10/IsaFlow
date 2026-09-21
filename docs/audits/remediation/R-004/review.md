# Independent review of b3b4a71d

Reviewer executed the combined guards over 60+ bypass candidates (quoted, schema-qualified, unicode-escaped function names; functions inside FILTER, aggregate ORDER BY, OVER, WITHIN GROUP, scalar subqueries, CTE bodies, cast chains; set-returning functions in select list and FROM; XMLTABLE, ROWS FROM, TABLESAMPLE, COLLATE, dollar quoting, E'' strings). All blocked or unparseable (fail closed). No allowlisted function reads a relation or file.

Findings and resolution (all addressed in the follow-up commit):
- HIGH, pre-existing: scope guard propagated scope through global reference tables without company_id (asset_categories, leave_types). Registered as R-009; fixed by NO_COMPANY_TABLES cut-off in reachability. Real-DB test proves a foreign asset is no longer returned.
- MEDIUM: reg* casts (regclass/regrole/regproc) enumerated catalog names with no FROM. Rejected at the cast node.
- MEDIUM: repeat/lpad/rpad unbounded memory. Removed from the allowlist.
- LOW: current_user/session_user/user keyword nodes leaked the role name. Rejected at the keyword node.
- LOW: allowlist gaps for common analytical SQL — see the reviewer's list below and the allowlist additions.

Reviewer's full continuation is preserved in review-remaining.md. Follow-up applied: the safe analytical functions listed there were added (format with its reasoning comment; random/clock_timestamp/timeofday left out; set-returning functions left out because the scope guard rejects them in FROM anyway), a test pins webhook_endpoints outside ALLOWED_TABLES, and the duplicated node type guard is now shared from nlQueryRelations. Not done: single-parse refactor (three parses per request retained; noted for the next change on this path). The integration tests run only when DATABASE_URL is set in CI; the unit tests are the mutation-proof gate.
