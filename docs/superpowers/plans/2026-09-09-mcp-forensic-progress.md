# MCP forensic controls progress ledger

## Authority and baseline
- Specification: committed c76b9706d84bd8c33fecad38d3aa9afe46fb424b, copied unchanged beside this ledger.
- Execution baseline: f57f71a75aa0c8ff2a0202c4b2c65d20f0de510e (fetched origin/master 2026-09-09).
- Integration branch: feat/mcp-forensic-controls-20260909.
- Integration worktree: /home/hein/Workspace/IsaFlow/.worktrees/mcp-forensic-integration-20260909.
- Original checkout and other sessions untouched. No production writes, messages, merges, or deployments authorized.
- Root owns shared contracts, registry/discovery, migration reservations, integration, and heavy-run scheduling.

## Phase/task status
| Task | Status | Owner | Evidence / next action |
| --- | --- | --- | --- |
| 0 baseline/remediation reconciliation | verified_current_schema | root | f57f71a7 baseline CI green Node22; historical replay220 limitation classified |
| 0 complete tool matrix | source_verified | inventory | forensic-evidence/tool-matrix.json: 131 tools,69 reads,62 writes,30 posting; runtime contract tests pending |
| 0 preventive bypass map/subplans | source_verified | preventive_map | forensic-evidence/phase1-preventive-plan.md and entrypoint-matrix.tsv; runtime reproductions planned |
| 0 evidence/detectors/subplans | source_verified | evidence_map | forensic-evidence/phase2-4-subplans.md |
| 0 disposable PostgreSQL and baseline CI | verified | root/evidence_map | reviewed fixture+3rootPGtests pass; current-schema upgrades616-618; historical replay220 separately limited |
| 0 shared contracts/requirement-test matrix | verified | root | 7e71e7d7 independent contract review clean;38requirements+22newtool contracts |
| 1 preventive shared controls | in_progress | root/permissions/approval | canonical+context reviewed; event writer626 undergoing proof; permission core+APapproval kernel underway |
| 2 change history/evidence | pending | unassigned | Minimal event writer required in Phase 1 |
| 3 detective checks | pending | unassigned | Reuse verified existing sources |
| 4 assurance/exceptions | pending | unassigned | Depends on consistent event/evidence contracts |
| 5 integrated proof/review/CI/draft PR | pending | root | All acceptance scenarios mandatory |

## Migration reservations
Root reservations after scanning all local/remote refs and existing worktree SQL filenames: 626 shared events/principal-lock helper; 627 operation approvals/policy versions; 628 beneficiary enforcement; 629 durable invocation/idempotency; 630 evidence/snapshot/exception jobs. Reservations627+ reordered centrally before any worker migration edits to match dependency order. Highest committed prefix was 625; no worktree file >=626 found. Recheck before commit/integration to avoid other-session races.

## Commands and findings
- `git fetch origin`: success; origin/master advanced c914f5b4 -> f57f71a7.
- `git worktree add ... -b feat/mcp-forensic-controls-20260909 f57f71a7`: success.
- Merged baseline includes remediation K001-K008/R003 plus supplier statement UUID/reconciliation fixes through PR356.
- Historical memory baseline CI omitted real DB integration; do not reuse as current verification.
- Existing committed fixture documentation reports historical migration replay stopping at 253; candidate baseline prerequisite until reproduced.

## Decisions
- Freeze f57f71a7 for initial baseline, inventory and CI; reconcile later upstream movement explicitly.
- User authorizes autonomous phase transitions and implementation decisions; routine skill confirmation gates are superseded.
- Preserve this durable ledger and evidence through completion and compaction.

## Review, blockers, verification levels
Baseline CI and reviewed foundations are recorded below. Full programme acceptance remains pending. Production unchanged and unverified.

## Resume
Read this ledger, worker report artifacts, and committed specification. Finish Phase 0 gate before dependent implementations. Never mark programme complete with pending capabilities/checks.

## Runtime and fixture
- Node v20.12.0 selected by nvm; Bun 1.3.9 installed (repo pin 1.3.2, minimum satisfied). Frozen install succeeded.
- Own container isaflow-forensic-pg-20260909, pgvector/pgvector:pg16, localhost:33149/isaflow_schema_fixture, disposable password forensic-local-only.
- Restored existing local schema-only artifact, preserving RLS/owners/grants; no source DB access. Restore log forensic-evidence/schema-restore.log. Historical migration replay and new upgrade migrations remain separate required evidence.
- Existing remediation branch list: forensic-evidence/remediation-branches.txt; baseline integrates only already-merged work.

## Baseline results and current tasks
- Node20.12 full CI exit1: unit/component Rolldown startup ERR_INVALID_ARG_VALUE format array; all remaining gates including build PASS. No app-code failure inferred. Log baseline-ci.log.
- Node22.23.1 full CI exit0 on a107aa8b (docs-only over f57f71a7): 787 unit files/9335 tests passed,36 files/234 tests skipped;57 component files/390 tests passed; build and all gates PASS. DATABASE_URL unset; no real DB acceptance in this run. Log baseline-ci-node22.log.
- Fresh historical migration replay first needs sslmode=disable, then fails at migration220 because companies does not exist. Confirmed pre-existing ordering prerequisite; new programme migrations will receive separate upgrade proof on current-schema fixture, historical replay remains tracked limitation.
- Shared contracts candidate and 38 requirement-to-test mappings recorded. Preventive worker reviewing cross-contract consistency; fixture worker owns safe bootstrap/tests, no heavy runs.

## Contract independent review
- preventive_map reviewed named4aa6907c: three confirmed contract gaps (multi-policy decision binding, nullable nonmonetary amount, employee beneficiary support). Fixed in following contract commit, plus explicit tx/lock/protected-evidence contracts. No code capability inferred from this review.

## Phase 0 gate and Phase 1 start
- Contract re-review of7e71e7d7: preventive_map confirms all three conflicts fixed; no remaining scoped contract blocker.
- Fixture3659c2ae independently reviewed clean, integrated aa16ec7a; root13unit pass. Worker realPG proof beaf6477 reports3pass (identity, RLS, rollback); review found P2 fault-injection cleanup setup gap, sent back for fix/re-review before integration of proof test.
- Phase0 source inventory, subplans,38requirement mappings, frozen contracts and reproducible current-schema baseline established. Historical empty replay gap remains confirmed baseline limitation, not waived proof. Synthetic fixture proof task cleanup fix still open; no Phase1 DB-dependent integration until reviewed.
- Root Phase1 common canonical contract task: tests written first; red missing module confirmed contracts-red.log; implemented real canonical material hashing/types;23unit pass, type-check and focused ESLint pass. Changes do not yet enforce financial operations. Independent review next.

## Integration through 30858728
- Fixture cleanup fixed3a796749; scoped review clean. Integrated1847ec5f/5c520265; root realPG rerun3pass on own33149 (fixture-postgres.log). Phase0 fixture proof complete; no production data.
- Canonical2003bddb review confirmed3P2 (locale ordering,nested validation,lossy arrays). Fixer24ae6eb3 reproduced16fail then53pass; scoped review clean; integrated30858728. No open canonical findings.
- Root transaction context task: missing-context and failed-evidence tests red before code. Cookie/bearer wrappers now bind authenticated principals and reject commit after required control evidence failure. Integrated focused79tests pass (context+canonical+3auth suites), type-check and focused lint pass. Independent review next; no shared financial writer integration claimed yet.
- Permissions worker branch feat/mcp-forensic-permissions-20260909 base2003bddb: live role/module/PAT/OAuth scope checks underway;21unit pass reported, DB proof and context integration pending. Worker waits root context commit.

## Current task ownership / next gates
- Contextba3d9ebd review found2P1 SQL/lifetime escape and1P2 buffered-response hang. Fixdf7e6e18 independently re-reviewed clean, integrated34751e31; helper signatures unchanged.
- Root event/protection task owns migration626,changeEventService.ts,changeProtection.ts,forensic-change-history.int.test.ts;5unit and initial3PG tests pass. Expanded4PG rerun awaits permissionDBlease; lint/typecheck pass; independent named review pending.
- Permissions08c72f17 source review no blocking code finding; P2 test defect(suspension masked foreigntenant assertion) sent to original worker. RealDB initial3pass1fail proved UPDATE-RLS membership-lock problem; root626 narrowdefiner helper fixes prerequisite, six-case rerun underway.
- Approval worker owns feat/mcp-forensic-approval-core-20260909 from34751e31, bounded AP approval kernel/materializers/tests; sends627schema contract to root. No domain executor integration claimed.

## Event foundation verification
- Root event/protection/version services: five unit tests and four real PostgreSQL tests pass, including encrypted exact/redacted generic history, database event time, stable operation identity, full rollback, concurrent version CAS, tenant isolation and caught encryption failure poisoning commit. Focused lint/typecheck pass; named-commit independent review pending. Logs change-history-green.log and change-protection-green.log. No domain writer enforcement yet.
- Current schema-only fixture retained privately at /home/hein/Workspace/IsaFlow/.worktrees/mcp-forensic-artifacts-20260909/current-schema.sql, mode600, SHA256 ad93bbd6286f113bfc68a564f9eb93abb232aa738d337a2754bb90d6c8677f5c. No production rows or production writes.

## Review corrections and approval schema
- Eventcb490931 independent preventive review found twoP1: default inherited UPDATE/DELETE grants defeated append-only ACL; context assertion outside failure handler let a caught invalid-context refusal commit earlier mutation. Both reproduced with real PostgreSQL failing tests, then fixed explicit privilege reset and failure-boundary context validation. Expanded sixPGtests pass; migration626 reapplied idempotently. Fix named-commit re-review pending.
- Reviewed permissioncore integrated7ba366d5, maskedtenant test root-reviewed32a3b8aa, proof8659b87f; worker sixPG and32focused tests pass. Current scope registry integration still pending.
- Root migration627 applied local-only: bound approval decisions, once-effect receipts, aggregate exposure, policy version/advisory serialization and current bound-authority helper. Kernel worker holds next DBlease; migration not yet independently reviewed.
