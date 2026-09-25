/**
 * Mutation counterexamples for workflowRunsCiRule (R-052). Each case edits the
 * REAL .github/workflows/ci.yml, the way someone would, and asserts the rule
 * refuses it. The bypass cases are the ones two blind reviewers got past the
 * first, grep-based version of this gate.
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { load } from 'js-yaml';
import { checkWorkflowRunsCi } from '../../../scripts/ci/workflowRunsCiRule';

const REAL = readFileSync('.github/workflows/ci.yml', 'utf8');
const SCRIPTS = (JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> }).scripts;
const GATE_LINE = '        run: bun run ci\n';

function check(yamlText: string, scripts: unknown = SCRIPTS): string[] {
  return checkWorkflowRunsCi(load(yamlText), scripts);
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
const QUALITY_INSTALL = '      - name: Install dependencies\n        run: bun install --frozen-lockfile\n\n      # The gate list';
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
    ['an earlier step rewrites run-ci.sh', edit(QUALITY_INSTALL, QUALITY_INSTALL.replace('--frozen-lockfile', '--frozen-lockfile && printf "exit 0\\n" > scripts/ci/run-ci.sh'))],
    ['an extra step before the gate', edit(QUALITY_INSTALL, `      - run: echo hi\n${QUALITY_INSTALL}`)],
    ['a step after the gate (e.g. one that always reports success)', edit(GATE_STEP, `${GATE_STEP}      - run: exit 0\n`)],
    ['checkout pinned to another ref', edit('      - uses: actions/checkout@v4\n\n      - name: Install dependencies\n        run: bun install --frozen-lockfile\n\n      # The gate list', '      - uses: actions/checkout@v4\n        with:\n          ref: master\n\n      - name: Install dependencies\n        run: bun install --frozen-lockfile\n\n      # The gate list')],
    ['checkout swapped for another action', edit('      - uses: actions/checkout@v4\n\n      - name: Install dependencies\n        run: bun install --frozen-lockfile\n\n      # The gate list', '      - uses: someone/checkout@v4\n\n      - name: Install dependencies\n        run: bun install --frozen-lockfile\n\n      # The gate list')],
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
    expect(checkWorkflowRunsCi(load(REAL), undefined).length).toBeGreaterThan(0);
  });

  it.each(['preci', 'postci', 'preinstall', 'install', 'postinstall', 'preprepare', 'postprepare'])(
    'a %s lifecycle script, which bun runs around install or ci and could rewrite run-ci.sh',
    (hook) => {
      expect(check(REAL, { ...SCRIPTS, [hook]: "printf 'exit 0' > scripts/ci/run-ci.sh" }).length).toBeGreaterThan(0);
    },
  );

  it('prepare repointed (it runs inside the allowed bun install)', () => {
    expect(check(REAL, { ...SCRIPTS, prepare: "printf 'exit 0' > scripts/ci/run-ci.sh" }).length).toBeGreaterThan(0);
  });

  it("branches: [master, '!master'], which GitHub reads as excluding master", () => {
    expect(check(edit('  pull_request:\n    branches: [master]\n', "  pull_request:\n    branches: [master, '!master']\n")).length).toBeGreaterThan(0);
    expect(check(edit('  push:\n    branches: [master]\n', "  push:\n    branches: [master, '!master']\n")).length).toBeGreaterThan(0);
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
