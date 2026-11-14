/**
 * Golden-paths quarantine: a test that flaked twice stops blocking merges until its tracking issue is fixed.
 *
 *   test('title', quarantined(1270), async ({ page }) => { ... });
 *
 * Rule: on a golden test's SECOND flake (red, then green on the same code), open or reuse a tracking issue, then
 * quarantine the test in a PR with that issue's number. The fix PR removes `quarantined(...)`. playwright-golden.config.ts
 * leaves quarantined tests out of every run (CI chunks and the post-deploy verify) unless GOLDEN_RUN_QUARANTINED=1,
 * which is how you check a fix. Use the helper, never the bare tag: a guard test refuses `@quarantine` anywhere else,
 * so every quarantined test names its issue.
 *
 * Not automatic: telling a flake from a regression needs a pass and a fail on the same tree (retries are 0), and
 * writing the quarantine from CI would need a write token in a job that runs PR code. Both stay with a human or agent.
 */
export const QUARANTINE_TAG = '@quarantine';
const ISSUES = 'https://github.com/Heinvv10/IsaFlow/issues/';

export interface QuarantineDetails {
  tag: string;
  annotation: { type: 'issue'; description: string };
}

export function quarantined(issue: number): QuarantineDetails {
  if (!Number.isInteger(issue) || issue <= 0) throw new Error(`quarantined() needs a tracking issue number, got ${issue}`);
  return { tag: QUARANTINE_TAG, annotation: { type: 'issue', description: `${ISSUES}${issue}` } };
}

/** The config's grepInvert: quarantined tests are skipped unless GOLDEN_RUN_QUARANTINED=1. */
export function quarantineGrepInvert(env: NodeJS.ProcessEnv): RegExp | undefined {
  return env.GOLDEN_RUN_QUARANTINED === '1' ? undefined : /@quarantine\b/;
}
