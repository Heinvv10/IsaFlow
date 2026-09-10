# MCP forensic controls programme handoff — 2026-09-10 08:50 SAST

## Objective and authority

Continue the active `/goal`: implement all six phases of
`c76b9706:docs/superpowers/plans/2026-09-09-mcp-forensic-controls.md` through
implementation, synthetic PostgreSQL and real local MCP/UI/REST workflows,
independent named-commit review, final `bun run ci`, feature push, and draft PRs.

Authorized: isolated implementation, synthetic local migrations/tests, commits,
feature pushes, and draft PR creation. Not authorized: merge, production deploy or
migration/data repair, real financial transactions, or external messages.

Read root/nested `AGENTS.md`; never edit master, stash, use `git add -A`, amend a
published commit, or read a review target from a mutable worktree. Use
`git show <sha>:<path>`. Prefix every shell command with the owned worktree path.

## Authoritative integration state

- Worktree: `/home/hein/Workspace/IsaFlow/.worktrees/mcp-forensic-integration-20260909`
- Branch: `feat/mcp-forensic-controls-20260909`
- Clean HEAD: `ae521235a5f8338b6cc66687ba43d9cdfe255b51`
- Programme ledger: `docs/superpowers/plans/2026-09-09-mcp-forensic-progress.md`
- This handoff is additive to that ledger; the full commit/test history remains there.
- Registry census at the latest completed transport checkpoint: 163 tools, 91
  reads, 72 writes, 32 post-required, 5 `scope:null`. Revalidate after later work.
- No feature push, draft PR, merge, production migration/deploy, production data
  repair, real financial transaction, or external message has occurred.

## Local test infrastructure

- Synthetic PostgreSQL container: `08fbe6f7e6f4`, name
  `isaflow-forensic-pg-20260909`, currently running at `127.0.0.1:33149`.
- Database: `isaflow_schema_fixture`; persistent volume
  `cd3c7f4f67813651b19abf334e467f10fc29ac11b9f7268ebcedd607652d133c`.
- Environment file (do not print values):
  `/home/hein/Workspace/IsaFlow/.worktrees/mcp-forensic-artifacts-20260909/fixture.env`.
- Runtime: `source /home/hein/.nvm/nvm.sh && nvm use 22.23.1`; Bun 1.3.9.
- No programme Vitest/TypeScript/build process was live at handoff. All workers
  were terminal; do not infer a live lease from old logs.
- Serialize PostgreSQL suites and resource-heavy TypeScript/build/CI work.

## Latest full CI

Exact state `fad0f57f7`, isolated worktree
`mcp-forensic-ci-fad0f57f7-20260910`, handle 87624 terminal exit 1. Durable log:
`mcp-forensic-artifacts-20260909/integrated-forensic-ci-fad0f57f7.log`.

- Passed: source TypeScript, lint, agent-docs, security/static guards, migration
  naming, 450 component tests, and production build.
- Unit gate: 5 failed, 10,882 passed, 233 skipped. Two credit-note context
  fixture failures are now fixed and integrated at `115132990`; 16 units and 4
  real app_user PostgreSQL cases passed.
- Three legacy historical-import boolean positive tests remain to be rewritten
  only after the real persisted platform-import capability passes. Do not restore
  the bypassing boolean behavior.
- Final integrated CI has not been run and is not green.

## Newly integrated UUID identity control

Integration HEAD includes a confirmed and corrected case-variant financial bug.
Before the fix, independently approved lower/uppercase UUIDs posted one 10.00 GL
historical import twice, producing two effects and debit/credit 20.00.

- Tests-first/evidence and source are integrated through `ae521235a`.
- Final independent review: `0acde12e8` source against `a62c492cd`, evidence
  `6ea7a9b1a`; no confirmed issue in the historical slice.
- Verification: 22 actual PostgreSQL cases, 24 units, scoped TypeScript, and typed
  lint pass. This includes lower/uppercase concurrent approvals, unchanged replay
  of a genuine legacy uppercase effect produced by exact old code, and refusal of
  genuinely ambiguous dual legacy effects. No signed/effect row was rewritten.
- The shared `canonicalOperationRef` now lowercases validated UUID entity IDs and
  preserves fiscal-year and VAT-period textual identities. Owning service
  boundaries must still canonicalize IDs before raw receipt/callback use.

## Ready candidates requiring review/integration

### Bank transfer UUID boundary

- Worktree: `.worktrees/mcp-bank-transfer-uuid-20260910`
- Clean candidate: `776c66912943a7e9ea9d0de19e5502f39457f5f7`
- Production source commit: `df3eb854b93d5906b98b35149d1af9267b9f10d8`
- Shared dependencies `3bcb454c5`/`2318356f6` are equivalent to already integrated
  `bca9a7645`/`d430ccad9`; do not duplicate them.
- Root independently reviewed the owning source and tests: canonical input before
  reads/callback/result, case-insensitive unique receipt, ambiguity refusal.
- Genuine RED: 4 PostgreSQL failures including double transfer totals 20.00 vs
  authorized 10.00. GREEN: 3 new + 11 existing + 1 genuine old-code legacy = 15
  PostgreSQL cases, dedicated TypeScript and typed lint pass. Legacy approval and
  effect rows remain byte-for-byte unchanged.
- Next: cherry-pick test commits `9f6afca06`, `723288bb5`, `6f05c8011`, source
  `df3eb854b`, and evidence `776c66912` only; resolve by named commit and rerun a
  combined focused suite on integration.

### Other controlled-intent UUID boundaries

- Worktree: `.worktrees/control-intent-case-boundaries-20260910`
- Clean evidence HEAD: `80b5e2f57cd58ef56f44580d4d797ba568e31bfa`
- Production source: `ec0eada73`; tests stack
  `acee1f0f1/4aafff196/86cfc4568/140fa3778`.
- Five owning files only: bank allocation, bank allocation reversal, cash
  application, cash application reversal, payroll compensation.
- Genuine RED: 10 actual PostgreSQL case failures (one fixture-name correction
  separated from product behavior) and 5 loader units. GREEN: 10 PostgreSQL and
  13 units; dedicated TypeScript and typed lint pass.
- Independent root review and integration are still required.
- The audit also identified later bounded work: asset depreciation, AR posting
  receipt, payroll posting receipt, bank statement attestation, invoice match
  override, and payment release owning boundaries. Payroll receipt replay may
  bypass requester/reviewer revocation because it returns directly instead of
  using `replayKnownOperationEffect`; validate with actual PostgreSQL before fix.

## Platform historical-import authority — active incomplete slice

- Worktree: `.worktrees/mcp-platform-import-authority-20260910`
- Clean candidate: `bc950250565ad651742276de44c813922ed57da5`
- Based on `fad0f57f7` plus A1 and staged-source-history integration.
- Earlier commits: permission RED `79616ca86`, permission implementation
  `ae8e5542d`, confinement RED `be687c719`, confinement implementation
  `7c87e73be`, refreshed base `6bc22e0e8`.
- Candidate adds fixed platform-import permission ceilings, exact source/action/
  operation confinement hooks, protected `platformImportMaker`, distinct
  persisted platform requester rechecks, and migration
  `675_platform_import_approval_authority.sql`.
- Migration 674 was taken by `.worktrees/fix-K-091/674_gl_accounts_normalise_subtype.sql`
  after the earlier reservation. A new all-worktree scan allocated 675. Migration
  675 applied twice successfully only to the synthetic database.
- Focused permission/confinement tests: 21 pass. The actual approval suite remains
  tests-only at `.worktrees/platform-import-approval-pg-20260910`, HEAD
  `06405e3f9`: original baseline 11 genuine failures/2 passes; current suite has
  14 cases covering real AR/AP amounts, independent tenant review, self-approval
  via another token, revoked maker/reviewer, separate account/source staleness,
  wrong hashes/targets/approval, concurrency, retry, rollback events, tenant
  isolation, and ordinary-journal refusal.
- Independent review of `bc9502505` found one confirmed P2 gap: alternate readers
  `readHistoricalImportSourceKind()` and `historicalImportInvoiceEvidence()` do
  not enforce the selected platform source/import target. Add failing tests, then
  call `assertPlatformImportSourceRead` before either metadata/summary read (or
  explicitly refuse platform auth there). Preserve ordinary member behavior.
- After that fix, run source/test TypeScript and typed lint, apply 675 twice to a
  fresh/reproducible synthetic schema if required, then cherry `bc9502505` plus
  corrections into the 14-case test worktree and run the actual suite. Obtain a
  new independent named-commit review before integration.

## Earlier verified programme capabilities

The ledger contains exact commits and evidence. Major integrated slices include:

- Shared transaction-bound principals, current permission rechecks, approvals,
  policy aggregation, immutable change/effect evidence, beneficiary and payment
  release controls, AR/AP/BANK/GL/payroll/period control paths.
- Private platform-admin target lifetime A1 at `fad0f57f7`: genuine detached
  write and same/cross-company deadlock reproductions preceded fixes; final 20
  actual PostgreSQL tests, 70 units, source TypeScript/lint passed and independent
  review was clean.
- Snapshot comparison/indexless conversion at merge `c9b4b8420`, migration 673:
  authenticated v1/v2 intents, bounded original index construction, ordered
  concurrent conversion, atomic comparison publication, MCP/REST delivery,
  current-rights checks, genuine cold-process and worker-kill/lease recovery.
  Evidence includes 23 MCP/REST/job/page PG cases, 6 legacy retry cases, 4 cold
  concurrent cases, and hard-kill recovery. Fresh 100k end-to-end scale remains
  unproven.
- Bounded staged-source history kind reader at `e55e0ea20`: 20 PG + 3 crypto tests,
  TypeScript/lint pass; missing oversized legacy proof remains unavailable.

## Programme requirements still open

Do not call the goal complete until all are closed with named evidence:

1. Finish and integrate platform historical-import authority and actual admin
   Sage retention/extraction/AR/AP saved execution plus relevant admin UI/REST.
2. Complete remaining direct shared writers/import/onboarding/admin/CLI/job paths,
   rollback tombstones, and all UUID owning boundaries listed above.
3. Build genuine complete large-data detective/history jobs. Current six detectors
   truncate at 10,000 parents, 101 children, or 100 documents; wrapping those
   queries is insufficient. Capture one immutable repeatable-read population,
   authenticate bounded pages/census, analyse all pages, publish complete per-check
   counts/totals/coverage, expose bounded finding pages, and fail incomplete runs.
4. Run fresh 100,000-row and other specified scale/resource/job-recovery scenarios.
   Prior retained-index timing is not proof of fresh end-to-end construction.
5. Complete the integrated supplier chain, payroll, close, backdated snapshot/diff,
   exception recheck/reopen, missing-evidence, tenant-isolation, concurrency and
   idempotent retry workflows through actual local MCP HTTP and relevant UI/REST.
6. Re-enumerate every registered tool and verify every contract/authorization path
   through actual local MCP HTTP. The older 163 census must not be assumed final.
7. Run final integrated `bun run ci`, obtain independent review of the exact final
   commit, push feature branches, and create draft PRs. Do not merge or deploy.

## Immediate resume order

1. Read the committed programme spec and this handoff via `git show`; inspect the
   clean integration HEAD and all candidate commits by name.
2. Integrate the reviewed historical UUID state is already done. Independently
   review and integrate bank-transfer and five-service UUID candidates; run their
   combined focused tests once, serially.
3. Add RED tests for the two alternate platform source readers, fix candidate
   `bc9502505`, then run the 14-case actual PostgreSQL authority suite and static
   checks. Fix confirmed findings, independently review, integrate.
4. Rerun the full unit gate to establish the new residual CI failures before the
   next implementation tranche. Do not run final CI until required workflows are
   actually implemented.
5. Continue the complete detective/history engine and remaining real UI/REST/MCP
   workflows. Keep the ledger current after every candidate/review/integration.

## Shared Git warning

Auto-gc has reported empty loose object
`6424759cd84a173086c695c9a3ada2ba4bab321a`. Read-only reachability checks found no
missing object reachable from current programme heads. Do not delete, prune, gc,
repair, or otherwise mutate shared objects blindly. Use `git -c gc.auto=0` for
programme commits/cherry-picks. This warning is not a current programme blocker.
