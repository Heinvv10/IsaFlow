# K-108 fix — approval rules accept any operator and then never match

**Trigger.** `conditionOperator` went from the request body to `condition_operator` unvalidated,
and `checkApproval`'s switch handled only `any`, `greater_than` and `greater_equal` with no
default. A rule saved with `gt` left `matches` false, the loop fell through to
`{ requiresApproval: false }` with no log and no error, and the UI still showed the rule as
active. R999,999 passed a rule labelled "payments over R1,000".

**After.** Three layers.
1. `CONDITION_OPERATORS` and `isConditionOperator` are exported from the service; the
   approval-rules route rejects anything else on POST and PUT with a 400 naming the allowed set.
2. `checkApproval` has a `default:` arm that logs at warn and sets `matches = true` — an
   unreadable rule demands approval instead of silently waiving it.
3. Migration `647_approval_rules_condition_operator_check.sql` adds a CHECK constraint,
   `NOT VALID`, inside a `DO` block that skips if it already exists.

`NOT VALID` is deliberate: rows written before the migration may already carry a bad operator,
and failing the migration would leave new writes unconstrained too. Existing rows keep working,
the fail-closed arm covers them, and the impact query below enumerates them.

**Files.** `pages/api/accounting/approval-rules.ts` (+7),
`src/modules/accounting/services/gl/approvalMatching.ts` (new — the operator allowlist, the row
mappers and `checkApproval`, split out of `approvalService.ts` to stay under the 300-line
ceiling; `approvalService.ts` re-exports them so no other import site changed),
`scripts/migrations/sql/647_approval_rules_condition_operator_check.sql` (new).

**Tests.** `tests/integration/k108-k109-approval-rules.int.test.ts` — 4 K-108 cases: create
refused, update refused with the stored operator unchanged, a real operator still fires, and a
direct SQL write refused by the constraint. `tests/unit/services/gl/approvalOperatorFailClosed.test.ts`
— 3 cases over a mocked driver for the default arm, which the constraint makes unreachable
through the database. Mutation-proofed; see `green.log`.

**Migration / rollback.** 647, additive, idempotent, applied to the fixture and re-run clean.
Rollback: `ALTER TABLE approval_rules DROP CONSTRAINT approval_rules_condition_operator_check;`

**Historical impact.** Read-only query, not run here:
```sql
SELECT company_id, id, name, document_type, condition_operator, condition_value, is_active
FROM approval_rules
WHERE condition_operator NOT IN ('any', 'greater_than', 'greater_equal');
```
Documents matching those rules were processed without the approval they were meant to need.
The rows themselves are not repaired — the correct operator is a business decision per rule.

**Limits.** The fail-closed arm changes behaviour: any company holding such a rule starts
requiring approval on documents that previously passed. Run the query above and tell those
companies before deploying. `condition_field` is still unvalidated; it was not in scope.

**Correction (second fixer).** The counts above were written before the tests existed: the file now
holds 9 tests — 4 K-108 operator cases, 2 `approver_role` allowlist cases (review L4, which shares
this route), and 3 K-109 cases. See `../K-043/green.log` for the re-run and the mutation round.

**Prefix rename (2026-09-09).** This migration was written as `632_` and renamed to `647_` — an
unmerged forensic branch already holds `632_forensic_lockdown_intents.sql`, and 626–644 are taken
across the parallel branches. Only the filename changed; the constraint is still
`approval_rules_condition_operator_check`, so the rollback statement above is unaffected. The
fixture's constraint was DROPPED and rebuilt from the renamed file to prove it, not merely skipped
by the idempotent DO block.
