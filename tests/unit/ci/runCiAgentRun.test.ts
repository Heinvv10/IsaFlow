/**
 * run-ci.sh runs the browser-tests and build steps through agent-run (Velo's
 * memory-capped systemd scope) when it is installed, and unchanged otherwise.
 * The REAL run-ci.sh runs with `bun` replaced by a stub that logs its arguments
 * (so no gate actually runs) and AGENT_RUN_BIN pointing at a fake agent-run
 * that logs and then execs its command, as the real one does.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const dir = mkdtempSync(join(tmpdir(), 'ci-agent-run-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const LOG = join(dir, 'calls.log');
const AGENT_RUN = join(dir, 'agent-run');
const NOT_EXECUTABLE = join(dir, 'agent-run-644');

writeFileSync(join(dir, 'bun'), [
  '#!/bin/bash',
  'echo "bun $*" >> "$STUB_LOG"',
  'case "$*" in',
  '  "run test:print") exit "${PRINT_RC:-0}" ;;',
  '  "run build") exit "${BUILD_RC:-0}" ;;',
  '  *integration/scope.ts*) exit 10 ;;', // GITHUB_ACTIONS case: skip integration, never run it
  'esac',
  'exit 0',
  '',
].join('\n'));
const fakeAgentRun = [
  '#!/bin/bash',
  'echo "agent-run $*" >> "$STUB_LOG"',
  '[ -n "${AGENT_RUN_RC:-}" ] && exit "$AGENT_RUN_RC"',
  'exec "$@"',
  '',
].join('\n');
writeFileSync(AGENT_RUN, fakeAgentRun);
writeFileSync(NOT_EXECUTABLE, fakeAgentRun);
chmodSync(join(dir, 'bun'), 0o755);
chmodSync(AGENT_RUN, 0o755);
chmodSync(NOT_EXECUTABLE, 0o644);

// Same isolation as ciSkipGlue.test.ts: a hook's GIT_DIR and the GitHub job's
// own CI/GITHUB_* variables are dropped, so each case sets exactly what it names.
const inherited = (k: string) => /^(GIT_|GITHUB_|RUNNER_|ACTIONS_|CI_)/.test(k) || k === 'CI';
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !inherited(k)));

function run(env: Record<string, string>): { status: number | null; out: string; calls: string[] } {
  writeFileSync(LOG, '');
  const r = spawnSync('/bin/bash', ['scripts/ci/run-ci.sh'], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 120_000,
    env: { ...baseEnv, PATH: `${dir}:${process.env.PATH}`, STUB_LOG: LOG, CI_SKIP_BUILD: '0', ...env },
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}`, calls: readFileSync(LOG, 'utf8').split('\n').filter(Boolean) };
}

const wrapped = (calls: string[]) => calls.filter((c) => c.startsWith('agent-run '));
const ranBoth = (calls: string[]) =>
  calls.includes('bun run test:print') && calls.includes('bun run build');

describe('run-ci.sh: agent-run wrapper', () => {
  it('wraps exactly browser-tests and build when agent-run is executable', () => {
    const r = run({ AGENT_RUN_BIN: AGENT_RUN });
    expect(r.status).toBe(0);
    expect(wrapped(r.calls)).toEqual([
      'agent-run bun run test:print',
      'agent-run env NODE_ENV=production bun run build',
    ]);
    expect(ranBoth(r.calls)).toBe(true);
  });

  it.each([
    ['absent', { AGENT_RUN_BIN: join(dir, 'absent') }],
    ['not executable', { AGENT_RUN_BIN: NOT_EXECUTABLE }],
    ['GITHUB_ACTIONS=true', { AGENT_RUN_BIN: AGENT_RUN, GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'pull_request' }],
    ['CI=true', { AGENT_RUN_BIN: AGENT_RUN, CI: 'true' }],
    ['CI_NO_AGENT_RUN=1', { AGENT_RUN_BIN: AGENT_RUN, CI_NO_AGENT_RUN: '1' }],
  ])('runs both steps unwrapped when %s', (_case, env) => {
    const r = run(env);
    expect(r.status).toBe(0);
    expect(wrapped(r.calls)).toEqual([]);
    expect(ranBoth(r.calls)).toBe(true);
    expect(r.out).not.toContain('CI_NO_AGENT_RUN=1');
  });

  it.each([
    ['browser-tests', { PRINT_RC: '3' }],
    ['build', { BUILD_RC: '1' }],
  ])('a failing %s still fails the gate through agent-run', (step, env) => {
    const r = run({ AGENT_RUN_BIN: AGENT_RUN, ...env });
    expect(r.status).toBe(1);
    expect(r.out).toContain(`[ci] ${step} FAIL`);
    expect(r.out).toMatch(new RegExp(`\\[ci\\] FAILED: ${step}$`, 'm'));
  });

  it('agent-run failing on its own (no scope) fails both steps', () => {
    const r = run({ AGENT_RUN_BIN: AGENT_RUN, AGENT_RUN_RC: '1' });
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/\[ci\] FAILED: browser-tests build$/m);
    expect(r.out).toContain('re-run with CI_NO_AGENT_RUN=1');
  });
});
