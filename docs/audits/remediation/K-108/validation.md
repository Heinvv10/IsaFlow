# K-108 — Approval rules accept any operator and then never match

**Claim.** `condition_operator` is written verbatim from the body and the evaluating switch has no default, so unknown operators silently return not-required.

**Disposition: confirmed.**

**Corrected trigger.** `pages/api/accounting/approval-rules.ts:25-29` destructures `conditionOperator` from the body with no validation and passes it straight to `createRule`. `src/modules/accounting/services/gl/approvalService.ts:74` writes it verbatim (`updateRule:94` likewise). `checkApproval:151-161` switches on it with only `any`, `greater_than` and `greater_equal`, and no default, so any other string leaves `matches` false. The loop then falls through to `{ requiresApproval: false }` at `:172` with no log and no error. The rule renders in the UI as active.

**Evidence.** Files above via `git show origin/master:<path>`; `condition_operator` is a plain `text NOT NULL DEFAULT 'greater_than'` with no CHECK constraint in the fixture schema.

**RED test.** `tests/integration/k108-k109-approval-rules.int.test.ts`, test "K-108" — failed. A rule created with operator `gt` and value 1000 is stored as `gt`, and a R999,999 payment check returns `requiresApproval: false`. Log: `red.log`.

**Reachability.** Any user with write access on the approval-rules page; also reachable from a mistyped or older client.

**Proposed minimal fix (3-6 lines).**
1. Export `const OPERATORS = ['any','greater_than','greater_equal'] as const` from `approvalService.ts` and reject anything else in `createRule`/`updateRule` with a `badRequest`.
2. Add a `default:` arm to the `checkApproval` switch that logs at warn level and treats the rule as matching (fail closed), so a bad rule cannot silently disable approval.
3. Add a CHECK constraint on `approval_rules.condition_operator` in a new migration.

**Historical-data impact.** Documents that should have required approval were processed without it wherever a rule carries an unrecognised operator. Read-only impact SQL:
```sql
SELECT company_id, id, name, condition_operator FROM approval_rules
WHERE condition_operator NOT IN ('any','greater_than','greater_equal');
```
Not run against production.

**Risks.** Fixing the switch to fail closed will start requiring approval for documents that previously passed; announce before deploying.
