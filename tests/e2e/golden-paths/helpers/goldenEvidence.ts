/**
 * What a red golden spec leaves behind. Off unless GOLDEN_EVIDENCE=1, which only the hosted CI step sets: the
 * production verify (scripts/verify-deploy.sh) shares playwright-golden.config.ts and must not write traces (a trace
 * holds request headers and cookies) next to the deploy. `retain-on-failure`, not `on-first-retry`: the suite runs
 * with retries: 0 (a retry would hide a flake), so a retry trace would never be recorded.
 */
export interface GoldenEvidence {
  trace: 'off' | 'retain-on-failure';
  screenshot: 'off' | 'only-on-failure';
}

export function goldenEvidence(env: NodeJS.ProcessEnv = process.env): GoldenEvidence {
  return env.GOLDEN_EVIDENCE === '1'
    ? { trace: 'retain-on-failure', screenshot: 'only-on-failure' }
    : { trace: 'off', screenshot: 'off' };
}
