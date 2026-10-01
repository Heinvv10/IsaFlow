/**
 * Mutation counterexamples for workflowRunsCiRule (R-052). Each case edits the
 * REAL .github/workflows/ci.yml, the way someone would, and asserts the rule
 * refuses it. The bypass cases are the ones two blind reviewers got past the
 * first, grep-based version of this gate.
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { load } from 'js-yaml';
import { checkWorkflowRunsCi, WORKFLOW_FILES } from '../../../scripts/ci/workflowRunsCiRule';

const REAL = readFileSync('.github/workflows/ci.yml', 'utf8');
const SCRIPTS = (JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> }).scripts;
const GATE_LINE = '        run: bun run ci\n';

function check(yamlText: string, scripts: unknown = SCRIPTS): string[] {
  return checkWorkflowRunsCi(load(yamlText), scripts, WORKFLOW_FILES);
}

function edit(from: string, to: string): string {
  expect(REAL.split(from).length - 1, `fixture anchor must occur once: ${from}`).toBe(1);
  return REAL.replace(from, to);
}

const GATE_STEP = [
  '      - name: CI gate (scripts/ci/run-ci.sh)',
  '        run: bun run ci',
  '        env:',
  '          DATABASE_URL: ${{ secrets.DATABASE_URL }}',
  '          JWT_SECRET: test-secret-for-ci-only',
  '          NODE_ENV: test',
  '',
].join('\n');
// The install step appears in both jobs; the gate comment makes this quality's.
const QUALITY_INSTALL = '      - name: Install dependencies\n        run: bun install --frozen-lockfile --ignore-scripts\n\n      # The gate list';
// Unique to quality: the --ignore-scripts comment follows its checkout.
const QUALITY_CHECKOUT = '      - uses: actions/checkout@v4\n\n      # --ignore-scripts';
const QUALITY_HEADER = '  quality:\n    name: Type Check, Lint & Test\n';

describe('the committed workflow', () => {
  it('passes', () => {
    expect(check(REAL)).toEqual([]);
  });

  it('parses `on` as a string key (YAML 1.2), so the trigger checks are real', () => {
    expect(Object.keys(load(REAL) as object)).toContain('on');
  });
});

describe('refuses every way found to keep the job green while skipping gates', () => {
  const cases: Array<[string, string]> = [
    ['if: false on the gate step', edit(GATE_LINE, `${GATE_LINE}        if: false\n`)],
    ['if: false on the job', edit(QUALITY_HEADER, `${QUALITY_HEADER}    if: false\n`)],
    ['shell override prints instead of running', edit(GATE_LINE, `${GATE_LINE}        shell: cat {0}\n`)],
    ['CI_SKIP_BUILD in the step env drops the build', edit('          NODE_ENV: test\n', '          NODE_ENV: test\n          CI_SKIP_BUILD: "1"\n')],
    ['an earlier step rewrites run-ci.sh', edit(QUALITY_INSTALL, QUALITY_INSTALL.replace('--ignore-scripts', '--ignore-scripts && printf "exit 0\\n" > scripts/ci/run-ci.sh'))],
    ['install without --ignore-scripts (root, workspace-member and trusted-dependency lifecycle scripts run and can rewrite run-ci.sh)', edit(QUALITY_INSTALL, QUALITY_INSTALL.replace(' --ignore-scripts', ''))],
    ['an extra step before the gate', edit(QUALITY_INSTALL, `      - run: echo hi\n${QUALITY_INSTALL}`)],
    ['a step after the gate (e.g. one that always reports success)', edit(GATE_STEP, `${GATE_STEP}      - run: exit 0\n`)],
    ['checkout pinned to another ref', edit(QUALITY_CHECKOUT, QUALITY_CHECKOUT.replace('@v4\n', '@v4\n        with:\n          ref: master\n'))],
    ['checkout swapped for another action', edit(QUALITY_CHECKOUT, QUALITY_CHECKOUT.replace('actions/checkout', 'someone/checkout'))],
    ['pull_request trigger removed', edit('  pull_request:\n    branches: [master]\n', '')],
    ['paths-ignore on pull_request', edit('  pull_request:\n    branches: [master]\n', '  pull_request:\n    branches: [master]\n    paths-ignore: ["**"]\n')],
    ['pull_request retargeted away from master', edit('  pull_request:\n    branches: [master]\n', '  pull_request:\n    branches: [release]\n')],
    ['quoted "continue-on-error" on the step', edit(GATE_LINE, `${GATE_LINE}        "continue-on-error": true\n`)],
    ['continue-on-error on the job', edit(QUALITY_HEADER, `${QUALITY_HEADER}    continue-on-error: true\n`)],
    ['flow-style step with continue-on-error', edit(GATE_STEP, '      - { name: CI gate, run: bun run ci, continue-on-error: true }\n')],
    ['gate replaced by one hand-picked gate', edit(GATE_LINE, '        run: bun run test:unit\n')],
    ['gate neutralised with || true', edit(GATE_LINE, '        run: bun run ci || true\n')],
    ['workflow-level env', edit('permissions:\n', 'env:\n  CI_SKIP_BUILD: "1"\n\npermissions:\n')],
    ['workflow-level defaults.run.shell', edit('permissions:\n', 'defaults:\n  run:\n    shell: cat {0}\n\npermissions:\n')],
    ['job-level env', edit(QUALITY_HEADER, `${QUALITY_HEADER}    env:\n      SKIP_CI: "1"\n`)],
  ];

  it.each(cases)('%s', (_label, mutated) => {
    expect(check(mutated).length).toBeGreaterThan(0);
  });

  it('the real step parked in a decoy job while quality runs one gate', () => {
    const mutated = edit(GATE_LINE, '        run: bun run test:unit\n') + [
      '  decoy:',
      '    if: false',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - run: bun run ci',
      '',
    ].join('\n');
    expect(check(mutated).length).toBeGreaterThan(0);
  });

  it('package.json `ci` turned into a no-op', () => {
    expect(check(REAL, { ...SCRIPTS, ci: 'true' }).length).toBeGreaterThan(0);
    expect(checkWorkflowRunsCi(load(REAL), undefined, WORKFLOW_FILES).length).toBeGreaterThan(0);
  });

  it.each(['preci', 'postci', 'pretype-check', 'postlint', 'pretest:unit', 'prebuild', 'precheck:routes', 'postinstall', 'preinstall'])(
    'a %s script: bun runs pre/post hooks around every bun run inside the gate, so it could defuse later gates',
    (hook) => {
      expect(check(REAL, { ...SCRIPTS, [hook]: "printf 'exit 0' > scripts/ci/run-ci.sh" }).length).toBeGreaterThan(0);
    },
  );

  it("branches: [master, '!master'], which GitHub reads as excluding master", () => {
    expect(check(edit('  pull_request:\n    branches: [master]\n', "  pull_request:\n    branches: [master, '!master']\n")).length).toBeGreaterThan(0);
    expect(check(edit('  push:\n    branches: [master]\n', "  push:\n    branches: [master, '!master']\n")).length).toBeGreaterThan(0);
  });

  it.each([
    ['a timeout too short to finish', 'timeout-minutes: 1'],
    ['a timeout given as an expression', "timeout-minutes: '30'"],
    ['a fractional timeout', 'timeout-minutes: 20.5'],
    ['no timeout floor (key removed)', null],
  ])('%s: the check ends cancelled, never red', (_label, line) => {
    // Anchored on quality's own comment: golden-paths also has timeout-minutes: 30.
    const from = '~3.5x headroom.\n    timeout-minutes: 30\n';
    expect(check(edit(from, line === null ? '~3.5x headroom.\n' : `~3.5x headroom.\n    ${line}\n`)).length).toBeGreaterThan(0);
  });

  it.each([
    ['a concurrency group shared by every ref', '  group: ci-fixed\n  cancel-in-progress: true\n'],
    ['cancel-in-progress switched off', '  group: ci-${{ github.ref }}\n  cancel-in-progress: false\n'],
    ['an extra concurrency key', '  group: ci-${{ github.ref }}\n  cancel-in-progress: true\n  queue: max\n'],
  ])('%s', (_label, body) => {
    expect(check(edit('  group: ci-${{ github.ref }}\n  cancel-in-progress: true\n', body)).length).toBeGreaterThan(0);
  });

  it('concurrency removed from the workflow', () => {
    expect(check(edit('concurrency:\n  group: ci-${{ github.ref }}\n  cancel-in-progress: true\n', '')).length).toBeGreaterThan(0);
  });

  it('a second workflow file (concurrency groups are repo-wide, so it can take ci- and cancel quality)', () => {
    expect(checkWorkflowRunsCi(load(REAL), SCRIPTS, ['ci.yml', 'evil.yml']).length).toBeGreaterThan(0);
    expect(checkWorkflowRunsCi(load(REAL), SCRIPTS, []).length).toBeGreaterThan(0);
  });

  it("golden-paths moved into the workflow's own ci- group (deadlock cancels the run)", () => {
    expect(check(edit('    concurrency:\n      group: golden-paths-dev-demo\n', '    concurrency:\n      group: ci-${{ github.ref }}\n')).length).toBeGreaterThan(0);
  });

  it('golden-paths concurrency removed or set to cancel', () => {
    expect(check(edit('    concurrency:\n      group: golden-paths-dev-demo\n      cancel-in-progress: false\n', '')).length).toBeGreaterThan(0);
    expect(check(edit('      cancel-in-progress: false\n', '      cancel-in-progress: true\n')).length).toBeGreaterThan(0);
  });

  it('actions: write on the workflow token (any job could then cancel the run)', () => {
    expect(check(edit('permissions:\n  contents: read\n', 'permissions:\n  contents: read\n  actions: write\n')).length).toBeGreaterThan(0);
    expect(check(edit('permissions:\n  contents: read\n', 'permissions: write-all\n')).length).toBeGreaterThan(0);
    expect(check(edit('permissions:\n  contents: read\n', '')).length).toBeGreaterThan(0);
  });

  it('a job widening its own token', () => {
    expect(check(edit('    concurrency:\n      group: golden-paths-dev-demo\n', '    permissions:\n      actions: write\n    concurrency:\n      group: golden-paths-dev-demo\n')).length).toBeGreaterThan(0);
  });

  it('a third job in ci.yml', () => {
    expect(check(`${REAL}  sidecar:\n    runs-on: [self-hosted, linux, velo]\n    concurrency:\n      group: ci-\${{ github.ref }}\n    steps:\n      - run: echo hi\n`).length).toBeGreaterThan(0);
  });

  it('runs-on a label no runner has, so the job queues forever and never goes red', () => {
    expect(check(edit(`${QUALITY_HEADER}    runs-on: [self-hosted, linux, velo]\n`, `${QUALITY_HEADER}    runs-on: [nonexistent-label]\n`)).length).toBeGreaterThan(0);
  });

  it('the quality job removed or renamed', () => {
    expect(check(edit('  quality:\n', '  checks:\n')).length).toBeGreaterThan(0);
  });
});

describe('accepts equivalent spellings of the one allowed shape', () => {
  it('a nameless step, a quoted command and a trailing comment', () => {
    expect(check(edit('      - name: CI gate (scripts/ci/run-ci.sh)\n        run: bun run ci\n', '      - run: bun run ci\n'))).toEqual([]);
    expect(check(edit(GATE_LINE, '        run: "bun run ci"\n'))).toEqual([]);
    expect(check(edit(GATE_LINE, '        run: bun run ci  # every gate\n'))).toEqual([]);
  });
});
