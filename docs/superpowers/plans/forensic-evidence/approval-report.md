# AP operation approval kernel — 2026-09-09

This bounded change implements the database-backed approval kernel for supplier invoices and payments. It does **not** yet protect existing domain routes from bypass: the next integration task must route actual financial writers through `executeControlledOperation` and its parent effect permit. No deploy, CI, production database access or real communications occurred.

## Interfaces and behavior

- `getApprovalRequirements(ctx, ref)` returns current matching policy requirements and server-derived amount/currency/version basis without creating history. Unsupported rules or ambiguous source facts refuse execution.
- `requestOperationApproval(ctx, ref)` locks current policies and owned AP sources, observes previously untracked source baselines with encrypted exact evidence, persists the binding and reserves configured aggregate exposure.
- `decideOperationApproval(ctx, approvalId, decision, evidenceRefs)` accepts only a current cookie-authenticated independent person with the configured policy role and current approval permissions. Decisions cover every eligible matching policy; evidence links are tenant-owned, parent-bound and checked again at execution.
- `executeControlledOperation(ctx, ref, approvalId, effect)` re-materializes current facts, checks all current policies and previously bound people, executes the callback under a short-lived parent permit, and stores its effect, approval consumption and committed change events in the same savepoint/transaction. Failed effects roll back consumption, allowing a valid retry. Concurrent use of one approval produces one effect.
- `assertControlledEffectPermit(ctx, permit, parent)` is an internal parent-identity guard for subsequent domain writer integration. Callers cannot construct a valid permit. Public request inputs contain no amount, beneficiary details or approver identity.

Invoice `approve` and `post` canonicalize to one operation. Invoice totals reconcile to lines; payment totals reconcile to owned allocations, deriving one unambiguous invoice currency. Current supplier bank facts produce a tenant-keyed fingerprint; legacy beneficiaries remain explicitly unverified. These AP operations use configured rules; mandatory external release and other programme policies belong to later operation materializers.

All active matching rules apply. Unsupported active rule semantics fail closed. Aggregate rules support one actual execution day in Africa/Johannesburg by supplier/currency, counting reserved pending/unexpired approvals and committed exposure. A shared tenant policy advisory lock serializes the read/reservation/effect with policy mutation, including newly inserted rules.

## Dependencies and schema feedback

Base `34751e31`; approved dependency cherry-picks: permission `08c72f17`, `3f25024c`, `183c4c13`; event foundation `cb490931` and correction `ade72372`. Migration 627 is root-owned and independently committed/reviewed. This worker edited no migrations, auth modules, existing domain writers or API routes.

Real PostgreSQL testing found that the initial root authority helper returned only decision people, leaving the requester absent before the first decision. Root corrected its sorted lock and return population to include the owned approval requester, current caller and decision people. The kernel does not impersonate a previously approving person through a fabricated context.

## Red/green evidence

Tests were written before the corresponding new rule/material/execution modules. Initial focused runs failed module resolution; logs remain `/tmp/operation-approval-{rules,material,execution}-red.log`. The first real PostgreSQL suite had six failures: spreading a persisted binding into its source reference changed the hash. Projection of exact OperationRef/EntityRef fields fixed that implementation defect. The next run had five authority failures and reproduced the helper omission above. A final fixture-only expiry failure was corrected by also backdating `requested_at`, preserving the database expiry constraint.

Final focused results:

- 18 unit tests in three files pass, 1.17 seconds, `/tmp/operation-approval-unit-green.log`.
- 10 real PostgreSQL tests pass, 7.27 seconds, `/tmp/operation-approval-pg-expanded.log`.
- Focused TypeScript check passes with incremental output disabled, `/tmp/operation-approval-typecheck.log`.
- Scoped source ESLint passes (`/tmp/operation-approval-source-lint.log`). Direct test-file lint encounters the repository project-service exclusion for tests (`/tmp/operation-approval-lint.log`); all owned tests are covered by the passing focused TypeScript check. No global lint configuration was changed.

The PostgreSQL suite used only the opt-in synthetic fixture on local port 33149, database `isaflow_schema_fixture`, with `SET LOCAL ROLE app_user` and real request contexts. It proves: inspection creates no history; a second token belonging to the requester cannot approve; self and foreign tenant decisions refuse; independent decision and concurrent one-time effect; failed effect rollback/retry; expired/cancelled/rejected terminal approvals; amount, policy and beneficiary staleness; new matching policy invalidation; revoked approver role/activity/explicit permission; every matching policy; configured decision role; disabled requester; invoice approve/post equivalence; concurrent split operations cannot both avoid an aggregate threshold. Pools release clients in finally and close after the suite.

Reproduce from this worktree with Node 22.23.1 in PATH:

```sh
node node_modules/vitest/vitest.mjs run tests/unit/services/controls/operationApprovalRules.test.ts tests/unit/services/controls/operationApprovalMaterial.test.ts tests/unit/services/controls/operationApprovalExecution.test.ts
# Set ISAFLOW_FORENSIC_FIXTURE_OPT_IN=1 and dedicated ISAFLOW_FORENSIC_FIXTURE_URL from the synthetic runtime environment.
node node_modules/vitest/vitest.mjs run --config vitest.integration.config.ts tests/integration/controls/operationApproval.int.test.ts
node node_modules/typescript/bin/tsc --project /tmp/isaflow-approval-tsconfig.json --noEmit
```

The focused tsconfig extends this worktree's root configuration and includes the six new source files plus their unit/integration tests, with `exclude: []` and `incremental: false`. No ambient application database URL is used to provision the fixture. Runtime encryption and fingerprint keys are newly generated synthetic values.

## Remaining integration boundary

Actual AP status eligibility, ledger accounts, domain authorization constraints and nested writer propagation must be enforced and tested when existing writers are connected. The synthetic effect callback proves transactional control behavior; it is not a production payment-posting test. Payroll, GL, period, beneficiary activation, external release, rule mutation APIs, parent batches and outbox adapters remain later scoped work. Independent commit review is pending; no whole-programme completion claim is made.
