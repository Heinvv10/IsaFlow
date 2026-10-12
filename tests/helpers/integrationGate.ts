/**
 * Whether this run is the CI integration gate (scripts/ci/integration/run.sh
 * sets CI_INTEGRATION_GATE=1 for every suite it runs).
 *
 * The gate runs six shards at once on a shared machine that sits at load
 * 50-250, so a wall-clock bound there measures the machine, not the code. The
 * few suites that assert one keep their correctness checks in the gate and
 * move the bound into its own test that skips there (with a
 * `ci-integration-skip:` comment the gate prints); run by hand, they assert
 * both as before.
 */
export const IN_INTEGRATION_GATE = process.env.CI_INTEGRATION_GATE === '1';
