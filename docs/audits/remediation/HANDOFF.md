# Remediation execution handoff

## Authoritative state

- Worktree: `/home/hein/Workspace/IsaFlow/.worktrees/audit-remediation-20260908`
- Branch: `fix/audit-remediation-20260908`
- Baseline and audit SHA: `5661d6f0f5f2212705151e95455a3f681ddf840e`.
- No behavior corrections implemented yet. No PR, deployment, or historical data mutation.
- Original audit documents preserved as 17 unique hashed snapshots; see inputs.json.
- 281 combined K candidates plus 2 supplemental AP-import claims retained. All 130 numbered A/B IDs are mapped (140 associations, including splits). Full details and remaining aggregate discrepancies are in reconciliation.md. No candidate disposition is established solely by mapping.
- Approved corrections are preserved in corrections.md; apply them during reconciliation before prioritizing.

## Runtime and verification

- Installed pinned Node 20.12.0 using nvm; frozen Bun install succeeded.
- Baseline full CI launched with `env -u DATABASE_URL -u CI_SKIP_BUILD bun run ci` under pinned Node; log: evidence/baseline-ci.log.
- Tool session handle: 65358. Finished with exit 1: unit/component startup fails on Node20 styleText array; all other gates, including build, passed. See evidence/baseline-summary.md. Full Node22 CI repeat finished with exit 0; integration tests remain skipped.
- DATABASE_URL intentionally absent: this baseline must not connect to shared production databases. Its integration skip remains an open required gate.
- Disposable PostgreSQL is running at localhost:33134. Migration replay is blocked at 220 by historical ordering and UUID/text mismatch; fixtures and workflow integration are not ready. See evidence/baseline-summary.md.
- `python3 docs/audits/remediation/render.py` validates K inventory uniqueness, numbered source uniqueness, mapped targets, preserved input hashes, and regenerates the dashboard. Passed. This is NOT full source-alias reconciliation acceptance.

## Next actions

1. Baseline CI results are recorded in evidence/baseline-summary.md: Node20 startup failures; Node22 executed gates pass. Integration coverage remains open.
2. Review reconciliation.md and all retained supplemental/compound checks; numbered ID mapping is complete, source count discrepancies remain visible.
3. Prepare disposable PostgreSQL using committed migrations and record setup limitations; do not use existing isaflow production containers.
4. Begin K-001 through actual committed auth callers, deterministic failing reproduction, exact fix plan, correction, regression/workflow, named-commit review, complete CI, focused draft PR.
5. Foundation committed as 18a30721; independent review requested exact source-set and supplemental-ID validation. Those corrections are applied locally with negative deletion checks. Stage explicit task paths only.

The goal remains active. There is no previous remediation turn evidence sufficient to classify an earlier turn; this turn made concrete progress by establishing the isolated execution branch, snapshots, register, runtime and running baseline gate.
