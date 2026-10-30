/**
 * Golden Paths after the merge (ci.yml): the smoke subset is the PR / merge-queue
 * check, the full suite runs only on a push to master and never skips, a
 * TEMPORARY shim carries the old required check name, and a red post-merge run
 * opens or updates a golden-paths-red issue. The shim's and the report's REAL
 * step scripts run here, with `gh` on PATH replaced by a stub that logs its
 * arguments and answers the two reads the report makes.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { load } from 'js-yaml';
import { REQUIRED_JOBS } from '../../../scripts/ci/mq-merge-already-tested';

type Step = { id?: string; if?: string; run?: string; uses?: string; env?: Record<string, string> };
type Job = { name?: string; if?: string; needs?: string | string[]; steps: Step[] };
const jobs = (load(readFileSync('.github/workflows/ci.yml', 'utf8')) as { jobs: Record<string, Job> }).jobs;
const scripts = (JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> }).scripts;
const lastRun = (job: Job) => job.steps[job.steps.length - 1]!.run!;

describe('which run gets which suite', () => {
  it('the full suite runs only on a push to master, under a name no required check has, and never skips', () => {
    const full = jobs['golden-paths']!;
    expect(full.name).toBe('Golden Paths E2E (post-merge)');
    expect(full.if).toBe("${{ github.event_name == 'push' }}");
    expect(full.steps.some((s) => s.id === 'mq' || s.if !== undefined)).toBe(false);
    expect(lastRun(full)).toMatch(/bun run test:e2e:golden\n?$/);
  });

  it('the smoke subset runs on every pull_request run (PR heads and merge-queue heads alike)', () => {
    const smoke = jobs['golden-paths-smoke']!;
    expect(smoke.name).toBe('Golden Paths smoke (blocking)');
    expect(smoke.if).toBe("${{ !cancelled() && github.event_name == 'pull_request' }}");
    expect(lastRun(smoke)).toMatch(/bun run test:e2e:golden:smoke\n?$/);
  });

  it('every spec the smoke script names exists (Playwright would quietly drop a missing one)', () => {
    const specs = scripts['test:e2e:golden:smoke']!.split(/\s+/).filter((a) => a.endsWith('.spec.ts'));
    expect(specs).toEqual([
      'tests/e2e/golden-paths/b-invoice-receipt-statement.spec.ts',
      'tests/e2e/golden-paths/f-bank-import-reconcile.spec.ts',
      'tests/e2e/golden-paths/g-journal-lifecycle.spec.ts',
      'tests/e2e/golden-paths/h-payroll-run.spec.ts',
    ]);
    for (const spec of specs) expect(existsSync(spec), spec).toBe(true);
    expect(scripts['test:e2e:golden:smoke']).toMatch(/^playwright test --config playwright-golden\.config\.ts /);
  });

  it("the merge check trusts the PR run's quality and smoke jobs, both of which run on pull_request", () => {
    const names = Object.values(jobs).map((j) => j.name);
    for (const name of REQUIRED_JOBS) expect(names).toContain(name);
    expect(REQUIRED_JOBS).not.toContain('Golden Paths E2E (post-merge)');
  });
});

const dir = mkdtempSync(join(tmpdir(), 'golden-after-merge-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const LOG = join(dir, 'gh.log');
writeFileSync(join(dir, 'gh'), [
  '#!/bin/bash',
  'args="$*"; echo "gh ${args//$\'\\n\'/ }" >> "$STUB_LOG"',
  'case "$1 $2" in',
  '  "api "*) echo "$STUB_STEPS"; exit "${STUB_API_RC:-0}" ;;',
  '  "issue list") [ -n "$STUB_OPEN" ] && printf "%s\\n" $STUB_OPEN ;;',
  'esac',
  'exit 0',
  '',
].join('\n'));
chmodSync(join(dir, 'gh'), 0o755);

function runStep(job: string, env: Record<string, string>): { status: number | null; calls: string[] } {
  writeFileSync(LOG, '');
  const script = join(dir, `${job}.sh`);
  writeFileSync(script, lastRun(jobs[job]!));
  const r = spawnSync('/bin/bash', [script], {
    encoding: 'utf8',
    env: { PATH: `${dir}:${process.env.PATH}`, STUB_LOG: LOG, ...env },
  });
  return { status: r.status, calls: readFileSync(LOG, 'utf8').split('\n').filter(Boolean) };
}

describe('the temporary "Golden Paths E2E (blocking)" shim', () => {
  it('carries the old required name, waits for smoke and runs even when smoke did not pass', () => {
    const shim = jobs['golden-paths-shim']!;
    expect(shim.name).toBe('Golden Paths E2E (blocking)');
    expect(shim.needs).toBe('golden-paths-smoke');
    expect(shim.if).toBe("${{ always() && github.event_name == 'pull_request' }}");
  });

  it.each([['success', 0], ['failure', 1], ['cancelled', 1], ['skipped', 1], ['', 1]])(
    'smoke %s -> exit %s', (smoke, want) => {
      expect(runStep('golden-paths-shim', { SMOKE: smoke }).status).toBe(want);
    },
  );
});

describe('the post-merge report', () => {
  const ENV = {
    GH_TOKEN: 't', REPO: 'o/r', RUN_URL: 'https://x/runs/9', RUN_ID: '9', RUN_ATTEMPT: '1',
    COMMIT_URL: 'https://x/commit/abc', SUBJECT: 'Merge pull request #7 from o/b\n\nbody line', STUB_STEPS: '0', STUB_OPEN: '',
  };
  const created = (calls: string[]) => calls.filter((c) => c.startsWith('gh issue create'));
  const commented = (calls: string[]) => calls.filter((c) => c.startsWith('gh issue comment'));

  it('runs after the full suite on every push, whatever its result', () => {
    const report = jobs['golden-paths-report']!;
    expect(report.needs).toBe('golden-paths');
    expect(report.if).toBe("${{ always() && github.event_name == 'push' }}");
  });

  it('red with no open issue: makes sure the label exists, opens one with the run and commit, and fails', () => {
    const r = runStep('golden-paths-report', { ...ENV, RESULT: 'failure' });
    expect(r.status).toBe(1);
    expect(r.calls.some((c) => c.startsWith('gh label create golden-paths-red'))).toBe(true);
    expect(created(r.calls)).toHaveLength(1);
    expect(created(r.calls)[0]).toContain('--label golden-paths-red');
    expect(created(r.calls)[0]).toContain('https://x/runs/9');
    expect(created(r.calls)[0]).toContain('https://x/commit/abc');
    expect(created(r.calls)[0]).toContain('Merge pull request #7 from o/b');
    expect(created(r.calls)[0]).not.toContain('body line');
  });

  it('red with an issue already open: comments on it instead of opening another', () => {
    const r = runStep('golden-paths-report', { ...ENV, RESULT: 'failure', STUB_OPEN: '41' });
    expect(r.status).toBe(1);
    expect(created(r.calls)).toHaveLength(0);
    expect(commented(r.calls)).toHaveLength(1);
    expect(commented(r.calls)[0]).toMatch(/^gh issue comment 41 /);
  });

  it('green: closes every open golden-paths-red issue and passes', () => {
    const r = runStep('golden-paths-report', { ...ENV, RESULT: 'success', STUB_OPEN: '41 42' });
    expect(r.status).toBe(0);
    expect(r.calls.filter((c) => c.startsWith('gh issue close')).map((c) => c.split(' ')[3])).toEqual(['41', '42']);
    expect(created(r.calls)).toHaveLength(0);
  });

  it('cancelled after it started (cancelled or timed out) counts as red', () => {
    const r = runStep('golden-paths-report', { ...ENV, RESULT: 'cancelled', STUB_STEPS: '4' });
    expect(r.status).toBe(1);
    expect(created(r.calls)[0]).toContain('did not finish');
  });

  it('cancelled before it started (superseded by a newer master push) reports nothing', () => {
    const r = runStep('golden-paths-report', { ...ENV, RESULT: 'cancelled', STUB_STEPS: '0' });
    expect(r.status).toBe(0);
    expect(created(r.calls)).toHaveLength(0);
    expect(commented(r.calls)).toHaveLength(0);
  });

  it.each([
    ['an API error', { STUB_STEPS: '', STUB_API_RC: '1' }],
    ['an answer that is not a count', { STUB_STEPS: 'not-a-number' }],
    ['an empty answer', { STUB_STEPS: '' }],
  ])('%s reading the cancelled job fails the report rather than staying quiet', (_label, over) => {
    const r = runStep('golden-paths-report', { ...ENV, RESULT: 'cancelled', ...over });
    expect(r.status).not.toBe(0);
    expect(created(r.calls)).toHaveLength(0);
  });
});
