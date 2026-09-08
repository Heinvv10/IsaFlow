# Remediation handoff

Continue the authorized remediation plan with progress updates; status questions do not cancel the task.

Five roots K-001 through K-005 are code-verified in the 284-item register; 279 candidates remain. Draft PRs 345, 346, 347, 348 and 350 are stacked on foundation PR 344. No merge, deployment or historical repair occurred.

K-005 fix a3278226 and review/documentation commit 8cff1456 passed full CI; draft PR 350 head verified as 8cff145616389fcbd05deed6220e62d86d9dec36. Eight real PostgreSQL/signed webhook cases and 643 regression tests passed. Migration 617 is installed only in the disposable fixture. R-003 remains the next candidate: first-registration provider ownership. Do not equate routing uniqueness with ownership proof.

Current branch fix/audit-k005-whatsapp-routing in audit-remediation-20260908. Preserve old untracked logs and stage explicit paths. Secondary audit-k004-capture-inbox-20260908 worktree can be reused on a new R-003 branch after this metadata commit. Its previous push is terminal. Shared node_modules; keep source/build isolated while push CI runs. Use Node 22.23.1 and Bun.

Disposable schema PostgreSQL is localhost33140/isaflow_schema_fixture; GoTrue localhost33138. Historical migration replay localhost33134 remains open at migration 253. Capture integration migration tests drop/restore their indexes and must run alone against the disposable fixture. Fixtures were cleaned after K-005. No production data copied or changed.
