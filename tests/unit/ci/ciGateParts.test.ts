/**
 * ci.yml runs each gate group hosted as a matrix of parts (`bun run ci static 2/3`).
 * Two halves, both against the REAL files:
 *   - run-ci.sh: the parts of a group together run exactly the gates the whole
 *     group runs, each once, with the test suites split by vitest --shard and
 *     integration by part; a malformed part is refused. `bun` and `bash` on
 *     PATH are stubs that log their arguments (as ciSkipGlue.test.ts), so no
 *     gate actually runs.
 *   - workflowRunsCiRule (R-052): the matrices are pinned, so a PR cannot drop a
 *     part, repeat one, or let one red part cancel the rest.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { load } from 'js-yaml';
import { checkWorkflowRunsCi, WORKFLOW_FILES } from '../../../scripts/ci/workflowRunsCiRule';

const dir = mkdtempSync(join(tmpdir(), 'ci-gate-parts-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const LOG = join(dir, 'calls.log');
writeFileSync(join(dir, 'bun'), '#!/bin/bash\necho "bun $*" >> "$STUB_LOG"\nexit 0\n');
writeFileSync(join(dir, 'bash'), '#!/bin/bash\necho "bash $*" >> "$STUB_LOG"\nexit 0\n');
chmodSync(join(dir, 'bun'), 0o755);
chmodSync(join(dir, 'bash'), 0o755);

// As ciSkipGlue.test.ts: drop the job's own GITHUB_*/CI variables, then set exactly what a pull_request run has.
const inherited = (k: string) => /^(GIT_|GITHUB_|RUNNER_|ACTIONS_|CI_)/.test(k) || k === 'CI';
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !inherited(k)));

function runCi(...args: string[]): { status: number | null; out: string; calls: string[] } {
  writeFileSync(LOG, '');
  const r = spawnSync('/bin/bash', ['scripts/ci/run-ci.sh', ...args], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 60_000,
    env: {
      ...baseEnv, PATH: `${dir}:${process.env.PATH}`, STUB_LOG: LOG, CI_SKIP_BUILD: '0', AGENT_RUN_BIN: join(dir, 'absent'),
      GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'pull_request',
    },
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}`, calls: readFileSync(LOG, 'utf8').split('\n').filter(Boolean) };
}

/** A call without its part: the --shard flag, or integration's PART/PARTS argument. */
const unparted = (c: string) => c.replace(/ --shard=\d+\/\d+$/, '').replace(/(integration\/run\.sh) \d+\/\d+$/, '$1');
const parts = (n: number) => Array.from({ length: n }, (_, i) => `${i + 1}/${n}`);

describe('run-ci.sh parts', () => {
  it.each([['static', 3], ['static', 2], ['static', 4], ['velo', 5], ['velo', 2]] as const)(
    '%s in %i parts runs every gate of the whole group, and each split gate in every share exactly once',
    (group, n) => {
      const whole = runCi(group);
      expect(whole.status).toBe(0);
      const split = parts(n).map((p) => runCi(group, p));
      for (const r of split) expect(r.status).toBe(0);
      // The integration scope check runs in every part; every other call is a gate.
      const calls = split.flatMap((r) => r.calls.filter((c) => !c.includes('integration/scope.ts')));
      const wholeGates = whole.calls.filter((c) => !c.includes('integration/scope.ts'));
      expect([...new Set(calls.map(unparted))].sort()).toEqual([...wholeGates].sort());
      // A gate that runs in several parts runs a different share in each, and the shares are 1..m of m.
      for (const gate of new Set(calls.map(unparted))) {
        const runs = calls.filter((c) => unparted(c) === gate);
        if (runs.length === 1) continue;
        const shares = runs.map((c) => /(\d+)\/(\d+)$/.exec(c)?.slice(1).join('/'));
        expect(shares.sort(), gate).toEqual(parts(runs.length).sort());
      }
    },
  );

  it('1/1 is the whole group, call for call', () => {
    for (const group of ['static', 'velo']) expect(runCi(group, '1/1').calls).toEqual(runCi(group).calls);
  });

  it('static: part 1 runs the checks and the build, the other parts split the two suites', () => {
    const [one, two, three] = parts(3).map((p) => runCi('static', p).calls);
    expect(one).toContain('bun run type-check');
    expect(one).toContain('bun run build');
    expect(one!.some((c) => c.startsWith('bun run test:'))).toBe(false);
    expect(two).toEqual(['bun run test:unit --shard=1/2', 'bun run test:components --shard=1/2']);
    expect(three).toEqual(['bun run test:unit --shard=2/2', 'bun run test:components --shard=2/2']);
  });

  it('velo: part k runs browser-tests shard k and integration part k', () => {
    const calls = runCi('velo', '4/5').calls;
    expect(calls).toContain('bun run test:print --shard=4/5');
    expect(calls).toContain('bash scripts/ci/integration/run.sh 4/5');
  });

  it.each([['static', '0/3'], ['static', '4/3'], ['static', '1/0'], ['velo', 'x'], ['velo', '1/2/3'], ['all', '1/2'], ['all', '2/2'], ['prepush', '1/2']])(
    'refuses %s %s before running anything',
    (group, part) => {
      const r = runCi(group, part);
      expect(r.status).toBe(2);
      expect(r.calls).toEqual([]);
      expect(r.out).toMatch(/usage: run-ci\.sh/);
    },
  );
});

describe('workflowRunsCiRule refuses a changed part matrix', () => {
  const REAL = readFileSync('.github/workflows/ci.yml', 'utf8');
  const SCRIPTS = (JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> }).scripts;
  const check = (text: string) => checkWorkflowRunsCi(load(text), SCRIPTS, WORKFLOW_FILES);
  function edit(from: string, to: string): string {
    expect(REAL.split(from).length - 1, `anchor must occur once: ${from}`).toBe(1);
    return REAL.replace(from, to);
  }
  const STATIC_PARTS = `'["1/3","2/3","3/3"]'`;
  const VELO_PARTS = `'["1/5","2/5","3/5","4/5","5/5"]'`;
  const STATIC_FF = '      # One red part must not cancel the others: the run lists every red gate.\n      fail-fast: false\n';
  const VELO_FF = '      # As in static.\n      fail-fast: false\n';

  it('the committed workflow passes', () => {
    expect(check(REAL)).toEqual([]);
  });

  it.each([
    ['a static part dropped (its gates never run)', STATIC_PARTS, `'["1/3","2/3"]'`],
    ['a static part repeated', STATIC_PARTS, `'["1/3","2/3","2/3"]'`],
    ['static split another way than run-ci.sh was reviewed for', STATIC_PARTS, `'["1/2","2/2"]'`],
    ['a velo part dropped', VELO_PARTS, `'["1/5","2/5","3/5","4/5"]'`],
    ['velo run as one hosted part', VELO_PARTS, `'["1/1"]'`],
    ['fail-fast on static (one red part cancels the rest)', STATIC_FF, STATIC_FF.replace('false', 'true')],
    ['fail-fast on velo', VELO_FF, VELO_FF.replace('false', 'true')],
    ['fail-fast left to its default (true)', STATIC_FF, ''],
    ['an extra matrix axis', VELO_FF, `${VELO_FF}      max-parallel: 1\n`],
    ['a gate step pinned to one part (parts 2 and 3 never run)', 'run: bun run ci static ${{ matrix.part }}', 'run: bun run ci static 1/3'],
    ['a part name that renders as the required check', "format('Static gates, part {0}', matrix.part)", "format('Type Check, Lint & Test{0}', '')"],
  ])('%s', (_label, from, to) => {
    expect(check(edit(from, to)).length).toBeGreaterThan(0);
  });

  it('the strategy removed from either job', () => {
    for (const ff of [STATIC_FF, VELO_FF]) {
      const block = REAL.slice(REAL.indexOf('    strategy:\n', REAL.indexOf(ff) - 200), REAL.indexOf(ff) + ff.length);
      expect(block.startsWith('    strategy:\n')).toBe(true);
      const matrixLine = REAL.slice(REAL.indexOf(ff) + ff.length).split('\n').slice(0, 2).join('\n') + '\n';
      expect(check(REAL.replace(block + matrixLine, '')).length).toBeGreaterThan(0);
    }
  });
});
