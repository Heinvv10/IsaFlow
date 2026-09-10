# Comparison hard-kill and lease recovery proof

Root tests-first commit bf1a33cec adds an actual cold-process test with an AFTER
INSERT trigger barrier inside indexless conversion. Independent legacy_retry_proof
review against519cec04e found no confirmed test defect before runtime execution.

Initial actual run88680 failed at a containment command. Diagnostic63022 localized
it to SIGKILL; stderr41490 established systemd255 rejected signaling auxiliary
processes with Invalid argument. This was not a rollback assertion failure.
The test now targets the verified main worker with SIGKILL. Discovery requires
exactly one direct systemd-run child of the current test process, the exact artifact,
and a freshly verified unit/MainPID command. It never selects unrelated workers.
Production containment code was not changed by this test correction.

Actual run67547 passed in6.51s using newly built .next/forensic/audit-job.cjs in
mcp-indexless-contracts-20260910. The test observes the real worker connection
blocked AFTER index insertion, kills its main process, verifies no index/companion
or result survives, verifies pre-expiry claim refusal, expires only the synthetic
lease, and runs a fresh process. Generation2 uses a new lease, succeeds with one
result and two attempts, preserves original protected material, and refuses a
further claim. Exact committed fixture credentials remain outside git.

Command: ISAFLOW_FORENSIC_PROCESS_TEST=1 and ISAFLOW_FORENSIC_AUDIT_ARTIFACT set
to the owned absolute artifact; bunx vitest run --config
vitest.integration.config.ts --no-file-parallelism
tests/integration/controls/comparisonKill.int.test.ts.

Durable logs in .worktrees/mcp-forensic-artifacts-20260909:
comparison-hard-kill.log, comparison-hard-kill-diagnostic.log,
comparison-hard-kill-stderr.log, comparison-hard-kill-main.log.
Dedicated changed-source/test TypeScript plus typed lint40185 exited0;
comparison-hard-kill-static.log. No production or large-population claim.
