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
  '          CI_READ_TOKEN: ${{ github.token }}',
  '          DATABASE_URL: ${{ secrets.DATABASE_URL }}',
  '          JWT_SECRET: test-secret-for-ci-only',
  '          NODE_ENV: test',
  '',
].join('\n');
// The install step appears in both jobs; the gate comment makes this quality's.
const QUALITY_INSTALL = '      - name: Install dependencies\n        run: bun install --frozen-lockfile --ignore-scripts\n\n      # The gate list';
// Unique to quality: the --ignore-scripts comment follows its checkout.
const QUALITY_CHECKOUT = '      - uses: actions/checkout@v4\n        with:\n          fetch-depth: 0\n          persist-credentials: false\n\n      # --ignore-scripts';
const GOLDEN_CHECKOUT = '      - uses: actions/checkout@v4\n        with:\n          fetch-depth: 0\n          persist-credentials: false\n\n      # A push';
const JOB_PERMS = '    permissions:\n      contents: read\n      actions: read\n      pull-requests: read\n';
const QUALITY_PERMS = `merged PR and its CI run's jobs (CI_READ_TOKEN below).\n${JOB_PERMS}`;
const GOLDEN_PERMS = `merge check below (as in quality).\n${JOB_PERMS}`;
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
    ['checkout pinned to another ref', edit(QUALITY_CHECKOUT, QUALITY_CHECKOUT.replace('fetch-depth: 0\n', 'ref: master\n'))],
    ['checkout swapped for another action', edit(QUALITY_CHECKOUT, QUALITY_CHECKOUT.replace('actions/checkout', 'someone/checkout'))],
    ['pull_request trigger removed', edit('  pull_request:\n    branches: [master]\n', '')],
    ['paths-ignore on pull_request', edit('  pull_request:\n    branches: [master]\n', '  pull_request:\n    branches: [master]\n    paths-ignore: ["**"]\n')],
    ['pull_request retargeted away from master', edit('  pull_request:\n    branches: [master]\n', '  pull_request:\n    branches: [release]\n')],
    ['quoted "continue-on-error" on the step', edit(GATE_LINE, `${GATE_LINE}        "continue-on-error": true\n`)],
    ['continue-on-error on the job', edit(QUALITY_HEADER, `${QUALITY_HEADER}    continue-on-error: true\n`)],
    ['flow-style step with continue-on-error', edit(GATE_STEP, '      - { name: CI gate, run: bun run ci, continue-on-error: true }\n')],
    ['gate replaced by one hand-picked gate', edit(GATE_LINE, '        run: bun run test:unit\n')],
    ['gate neutralised with || true', edit(GATE_LINE, '        run: bun run ci || true\n')],
    // Top-level only: the jobs' own permissions blocks are indented.
    ['workflow-level env', edit('\npermissions:\n', '\nenv:\n  CI_SKIP_BUILD: "1"\n\npermissions:\n')],
    ['workflow-level defaults.run.shell', edit('\npermissions:\n', '\ndefaults:\n  run:\n    shell: cat {0}\n\npermissions:\n')],
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
    // Anchored on quality's own comment: golden-paths has a timeout-minutes too.
    const from = 'so 120.\n    timeout-minutes: 120\n';
    expect(check(edit(from, line === null ? 'so 120.\n' : `so 120.\n    ${line}\n`)).length).toBeGreaterThan(0);
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

  it.each([
    ['golden-paths', GOLDEN_PERMS],
    ['quality', QUALITY_PERMS],
  ])('%s widening its own token', (_job, from) => {
    expect(check(edit(from, from.replace('actions: read', 'actions: write'))).length).toBeGreaterThan(0);
    expect(check(edit(from, from.replace('      pull-requests: read\n', '      pull-requests: read\n      checks: write\n'))).length).toBeGreaterThan(0);
    expect(check(edit(from, from.replace(JOB_PERMS, '    permissions: write-all\n'))).length).toBeGreaterThan(0);
  });

  it('checkout given any input but fetch-depth: 0 and persist-credentials: false', () => {
    expect(check(edit(QUALITY_CHECKOUT, QUALITY_CHECKOUT.replace('fetch-depth: 0\n', 'fetch-depth: 0\n          ref: master\n'))).length).toBeGreaterThan(0);
    expect(check(edit(QUALITY_CHECKOUT, QUALITY_CHECKOUT.replace('fetch-depth: 0\n', 'fetch-depth: 1\n'))).length).toBeGreaterThan(0);
  });

  it.each([
    ['quality', QUALITY_CHECKOUT],
    ['golden-paths', GOLDEN_CHECKOUT],
  ])('%s leaving its read token in .git/config (persist-credentials dropped or true)', (_job, from) => {
    expect(check(edit(from, from.replace('          persist-credentials: false\n', ''))).length).toBeGreaterThan(0);
    expect(check(edit(from, from.replace('persist-credentials: false', 'persist-credentials: true'))).length).toBeGreaterThan(0);
    expect(check(edit(from, from.replace('persist-credentials: false', "persist-credentials: 'false'"))).length).toBeGreaterThan(0);
  });

  it('CI_READ_TOKEN set to anything but the job token (the merge check trusts the API it reaches)', () => {
    expect(check(edit('          CI_READ_TOKEN: ${{ github.token }}\n          DATABASE_URL', '          CI_READ_TOKEN: ${{ secrets.OTHER }}\n          DATABASE_URL')).length).toBeGreaterThan(0);
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

  it('quality without the job permissions block, and then a checkout without inputs', () => {
    const narrow = edit(QUALITY_PERMS, QUALITY_PERMS.replace(JOB_PERMS, ''));
    expect(checkWorkflowRunsCi(load(narrow), SCRIPTS, WORKFLOW_FILES)).toEqual([]);
    const bare = narrow.replace(QUALITY_CHECKOUT, QUALITY_CHECKOUT.replace('        with:\n          fetch-depth: 0\n          persist-credentials: false\n', ''));
    expect(bare).not.toBe(narrow);
    expect(checkWorkflowRunsCi(load(bare), SCRIPTS, WORKFLOW_FILES)).toEqual([]);
  });
});
