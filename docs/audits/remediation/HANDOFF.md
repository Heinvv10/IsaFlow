# Remediation execution handoff

- Active worktree: `/home/hein/Workspace/IsaFlow/.worktrees/audit-remediation-20260908`; branch `fix/audit-k002-company-standing`.
- Baseline: `5661d6f0f5f2212705151e95455a3f681ddf840e`. Foundation draft PR #344; K-001 draft PR #345, stacked on foundation.
- Scope: 283 retained candidates, 130 numbered A/B source IDs mapped, 17 hashed input snapshots. Reconciliation caveats remain open.
- K-001: initial pending-MFA regression reproduced and fixed; resulting impersonation regression corrected in 23608ad7. Named application review approved and full CI passed. New real PostgreSQL/GoTrue test passed twice with actual authorization, tenant RLS/GUC, refresh, stash/audit persistence, and admin return. Test commit d626b33f was independently approved and pushed after full CI exit 0 (9304 unit, 384 component passed; 234 unit skipped). K-001 is code-verified; no deployment.
- Node 22.23.1 runs CI; pinned Node20 baseline fails Rolldown styleText startup. See evidence/baseline-summary.md.
- Empty schema-only fixture on localhost:33140 enables real SQL/RLS verification; see evidence/schema-fixture.md. No production rows copied or changed. Disposable GoTrue localhost:33138. Historical pristine replay on localhost:33134 remains open at migration253, after explicitly documented local adapters; never report it passed.
- Next: publish final evidence metadata, then validate K-002 against a named commit and reproduce before fixing. PR345 application/test head d626b33f passed full push CI; final metadata publication is a separate commit.
- No deployment, merge, production-data changes or historical repairs authorized. Goal remains active.

## K-002 active work

- Company standing reproduced on435071fd against real PostgreSQL:4 failures (cookie/PAT after suspension/deletion returned200 rather than403). No intervening master changes; remote master still5661d6f0.
- Fix b5e0ab31 uses shared companyMembership lookup under existing app_user transaction.13 real company-standing cases pass (cookie/PAT/OAuth/print, suspension/deletion/marker, nullable-status viewer), and K001 integration still passes. Existing auth319 passed. Named fix review approved; see K-002/review.md.
- Push/CI handle20071, log `/tmp/isaflow-k002-push.log`, must poll terminal state. Application code remains stable b5e0ab31; extra test/review metadata committed afterward. No K002 PR yet; create focused draft stacked on fix/audit-k001-mfa-session only after fullCI.
- Next: finish K002 CI/publication, update register/dashboard to code-verified only when gates established. Do not begin K003 yet.
