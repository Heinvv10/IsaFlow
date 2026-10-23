/**
 * The shell glue around the two skip decisions: run-ci.sh's handling of
 * mq-merge-already-tested.ts and integration/scope.ts exit codes, and the
 * golden-paths `mq` step in ci.yml. The REAL run-ci.sh and the REAL step script
 * run, with `bun` and `bash` on PATH replaced by stubs that log their arguments
 * (so no gate actually runs) and return the exit code each case asks for.
 * Only exit 10 may skip; 0, 1 and 127 (bun missing) must run everything.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { load } from 'js-yaml';

const dir = mkdtempSync(join(tmpdir(), 'ci-skip-glue-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const LOG = join(dir, 'calls.log');

writeFileSync(join(dir, 'bun'), [
  '#!/bin/bash',
  'echo "bun $* token=${CI_READ_TOKEN:-unset}" >> "$STUB_LOG"',
  'case "$*" in',
  '  *mq-merge-already-tested.ts*) exit "$MQ_RC" ;;',
  '  *integration/scope.ts*) exit "$SCOPE_RC" ;;',
  'esac',
  'exit 0',
  '',
].join('\n'));
writeFileSync(join(dir, 'bash'), '#!/bin/bash\necho "bash $*" >> "$STUB_LOG"\nexit 0\n');
chmodSync(join(dir, 'bun'), 0o755);
chmodSync(join(dir, 'bash'), 0o755);

// A hook (pre-push) exports GIT_DIR; run-ci.sh's `git rev-parse` must see this repo.
// On the GitHub runner the job's own GITHUB_ACTIONS=true, GITHUB_EVENT_NAME etc.
// are inherited: drop them so each case sets exactly the environment it names.
const inherited = (k: string) => /^(GIT_|GITHUB_|RUNNER_|ACTIONS_|CI_)/.test(k) || k === 'CI';
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !inherited(k)));

function run(script: string[], env: Record<string, string>): { status: number | null; out: string; calls: string[] } {
  writeFileSync(LOG, '');
  const r = spawnSync('/bin/bash', script, {
    cwd: process.cwd(), encoding: 'utf8',
    env: { ...baseEnv, PATH: `${dir}:${process.env.PATH}`, STUB_LOG: LOG, CI_SKIP_BUILD: '0', ...env },
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}`, calls: readFileSync(LOG, 'utf8').split('\n').filter(Boolean) };
}

const GH = { GITHUB_ACTIONS: 'true', CI_READ_TOKEN: 'tok' };
const ranGates = (calls: string[]) => calls.some((c) => c.startsWith('bun run type-check'));
const ranIntegration = (calls: string[]) => calls.includes('bash scripts/ci/integration/run.sh');

describe('run-ci.sh: the merge check', () => {
  it('exit 10 on a push skips every gate and exits 0', () => {
    const r = run(['scripts/ci/run-ci.sh'], { ...GH, GITHUB_EVENT_NAME: 'push', MQ_RC: '10', SCOPE_RC: '0' });
    expect(r.status).toBe(0);
    expect(ranGates(r.calls)).toBe(false);
    expect(r.out).toMatch(/all checks skipped/);
  });

  it.each(['0', '1', '127'])('exit %s runs every gate', (rc) => {
    const r = run(['scripts/ci/run-ci.sh'], { ...GH, GITHUB_EVENT_NAME: 'push', MQ_RC: rc, SCOPE_RC: '0' });
    expect(r.status).toBe(0);
    expect(ranGates(r.calls)).toBe(true);
    expect(ranIntegration(r.calls)).toBe(true);
  });

  it('is not asked on a pull_request, nor outside GitHub', () => {
    for (const env of [{ ...GH, GITHUB_EVENT_NAME: 'pull_request' }, { GITHUB_EVENT_NAME: 'push', CI_READ_TOKEN: 'tok' }]) {
      const r = run(['scripts/ci/run-ci.sh'], { ...env, MQ_RC: '10', SCOPE_RC: '0' });
      expect(r.calls.some((c) => c.includes('mq-merge-already-tested.ts'))).toBe(false);
      expect(ranGates(r.calls)).toBe(true);
    }
  });

  // The environment only: .git/config is covered by workflowRunsCiRule, which
  // requires persist-credentials: false on a job with the wider token.
  it('no gate after the check has CI_READ_TOKEN in its environment', () => {
    const r = run(['scripts/ci/run-ci.sh'], { ...GH, GITHUB_EVENT_NAME: 'push', MQ_RC: '0', SCOPE_RC: '0' });
    const mq = r.calls.filter((c) => c.includes('mq-merge-already-tested.ts'));
    expect(mq).toEqual(['bun scripts/ci/mq-merge-already-tested.ts token=tok']);
    expect(r.calls.filter((c) => c.startsWith('bun ') && !c.includes('mq-merge')).every((c) => c.endsWith('token=unset'))).toBe(true);
  });
});

describe('run-ci.sh: the integration scope', () => {
  it('exit 10 on GitHub skips integration and says so; the other gates run', () => {
    const r = run(['scripts/ci/run-ci.sh'], { ...GH, GITHUB_EVENT_NAME: 'pull_request', MQ_RC: '0', SCOPE_RC: '10' });
    expect(r.status).toBe(0);
    expect(ranIntegration(r.calls)).toBe(false);
    expect(ranGates(r.calls)).toBe(true);
    expect(r.out).toMatch(/integration: SKIPPED/);
  });

  it.each(['0', '1', '127'])('exit %s runs integration', (rc) => {
    const r = run(['scripts/ci/run-ci.sh'], { ...GH, GITHUB_EVENT_NAME: 'pull_request', MQ_RC: '0', SCOPE_RC: rc });
    expect(ranIntegration(r.calls)).toBe(true);
  });

  it('a local CI_INTEGRATION=1 runs integration without asking', () => {
    const r = run(['scripts/ci/run-ci.sh'], { CI_INTEGRATION: '1', MQ_RC: '0', SCOPE_RC: '10' });
    expect(r.calls.some((c) => c.includes('integration/scope.ts'))).toBe(false);
    expect(ranIntegration(r.calls)).toBe(true);
  });
});

describe('ci.yml golden-paths: the merge-check step', () => {
  type Step = { id?: string; if?: string; run?: string; uses?: string; env?: Record<string, string> };
  const steps = ((load(readFileSync('.github/workflows/ci.yml', 'utf8')) as { jobs: Record<string, { steps: Step[] }> })
    .jobs['golden-paths']!.steps);
  const at = steps.findIndex((s) => s.id === 'mq');

  it('follows only the checkout, and gates every later step on its output', () => {
    expect(at).toBe(1);
    expect(steps[0]!.uses).toMatch(/^actions\/checkout@/);
    for (const s of steps.slice(at + 1)) expect(s.if).toBe("steps.mq.outputs.skip != 'true'");
  });

  it('passes the job token to the check (without it every push runs the full suite)', () => {
    expect(steps[at]!.env).toEqual({ CI_READ_TOKEN: '${{ github.token }}' });
  });

  function step(event: string, rc: string): string {
    const out = join(dir, 'gh-output');
    writeFileSync(out, '');
    const script = join(dir, 'step.sh');
    writeFileSync(script, steps[at]!.run!);
    run([script], { GITHUB_EVENT_NAME: event, GITHUB_OUTPUT: out, MQ_RC: rc, SCOPE_RC: '0' });
    return readFileSync(out, 'utf8').trim();
  }

  it('skip=true only for exit 10 on a push', () => {
    expect(step('push', '10')).toBe('skip=true');
    for (const rc of ['0', '1', '127']) expect(step('push', rc)).toBe('skip=false');
    expect(step('pull_request', '10')).toBe('skip=false');
  });
});
