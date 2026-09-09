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
| 0 baseline/remediation reconciliation | in_progress | root | Selected latest merged baseline; unmerged work not absorbed |
| 0 complete tool matrix | in_progress | inventory | Read-only exact-baseline report /tmp/isaflow-forensic-phase0-inventory/ |
| 0 preventive bypass map/subplans | in_progress | preventive_map | Report /tmp/isaflow-forensic-phase0-preventive/ |
| 0 evidence/detectors/subplans | in_progress | evidence_map | Report /tmp/isaflow-forensic-phase0-evidence/ |
| 0 disposable PostgreSQL and baseline CI | pending | root | Inspect fixture prerequisites, provision own instance |
| 0 shared contracts/requirement-test matrix | pending | root | Reconcile worker reports |
| 1 preventive shared controls | pending | unassigned | Depends on Phase 0 gate |
| 2 change history/evidence | pending | unassigned | Minimal event writer required in Phase 1 |
| 3 detective checks | pending | unassigned | Reuse verified existing sources |
| 4 assurance/exceptions | pending | unassigned | Depends on consistent event/evidence contracts |
| 5 integrated proof/review/CI/draft PR | pending | root | All acceptance scenarios mandatory |

## Migration reservations
Root reservations after scanning all local/remote refs and existing worktree SQL filenames: 626 shared preventive contracts/events; 627 beneficiary enforcement; 628 durable invocation/idempotency; 629 evidence/snapshot/exception jobs. Highest committed prefix was 625; no worktree file >=626 found. Recheck before commit/integration to avoid other-session races.

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
No implementation or independent review completed. Baseline CI running (PTY session 48068): type-check, lint and intermediate gates completed; build still pending. Own schema fixture restored successfully (session 32958): 293 public tables, zero companies/users before synthetic seeding. No programme acceptance yet. Production unchanged and unverified.

## Resume
Read this ledger, worker report artifacts, and committed specification. Finish Phase 0 gate before dependent implementations. Never mark programme complete with pending capabilities/checks.

## Runtime and fixture
- Node v20.12.0 selected by nvm; Bun 1.3.9 installed (repo pin 1.3.2, minimum satisfied). Frozen install succeeded.
- Own container isaflow-forensic-pg-20260909, pgvector/pgvector:pg16, localhost:33149/isaflow_schema_fixture, disposable password forensic-local-only.
- Restored existing local schema-only artifact, preserving RLS/owners/grants; no source DB access. Restore log forensic-evidence/schema-restore.log. Historical migration replay and new upgrade migrations remain separate required evidence.
- Existing remediation branch list: forensic-evidence/remediation-branches.txt; baseline integrates only already-merged work.
