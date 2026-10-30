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
// static-fallback runs the same command under its own step name.
const GATE_LINE = '      - name: CI gate (scripts/ci/run-ci.sh static)\n        run: bun run ci static\n';
const VELO_GATE_LINE = '        run: bun run ci velo\n';

function check(yamlText: string, scripts: unknown = SCRIPTS): string[] {
  return checkWorkflowRunsCi(load(yamlText), scripts, WORKFLOW_FILES);
}

function edit(from: string, to: string): string {
  expect(REAL.split(from).length - 1, `fixture anchor must occur once: ${from}`).toBe(1);
  return REAL.replace(from, to);
}

const GATE_STEP = [
  '      - name: CI gate (scripts/ci/run-ci.sh static)',
  '        run: bun run ci static',
  '        env:',
  '          CI_READ_TOKEN: ${{ github.token }}',
  '          DATABASE_URL: ${{ secrets.DATABASE_URL }}',
  '          JWT_SECRET: test-secret-for-ci-only',
  '          NODE_ENV: test',
  '',
].join('\n');
// The install step appears in static and velo; the gate comment makes this static's.
const QUALITY_INSTALL = '      - name: Install dependencies\n        run: bun install --frozen-lockfile --ignore-scripts\n\n      # The gate list';
// Unique to static: the hosted-setup comment follows its checkout.
const QUALITY_CHECKOUT = '      - uses: actions/checkout@v4\n        with:\n          fetch-depth: 0\n          persist-credentials: false\n\n      # GitHub-hosted only';
const VELO_CHECKOUT = '      - uses: actions/checkout@v4\n        with:\n          fetch-depth: 0\n          persist-credentials: false\n\n      # As in static.';
const GOLDEN_CHECKOUT = '      - uses: actions/checkout@v4\n        with:\n          fetch-depth: 0\n          persist-credentials: false\n\n      # A push';
const JOB_PERMS = '    permissions:\n      contents: read\n      actions: read\n      pull-requests: read\n';
const QUALITY_PERMS = `merged PR and its CI run's jobs (CI_READ_TOKEN below).\n${JOB_PERMS}`;
const GOLDEN_PERMS = `merge check below (as in quality).\n${JOB_PERMS}`;
const VELO_PERMS = `# As in static (the merge check).\n${JOB_PERMS}`;
const QUALITY_HEADER = '  quality:\n    name: Type Check, Lint & Test\n';
const STATIC_HEADER = '  static:\n    name: Static gates\n';
const VELO_HEADER = '  velo:\n    name: Browser & integration (velo)\n';
const AGGREGATE = '          [ "$ROUTE" = "success" ] && [ "$VELO" = "success" ] && { [ "$STATIC" = "success" ] || [ "$FALLBACK" = "success" ]; }\n';
const FALLBACK_HEADER = '  static-fallback:\n    name: Static gates (velo fallback)\n';
const FALLBACK_DECIDE = '          if [ "$job" != "|0" ]; then\n';
const GOLDEN_GROUP = "      group: golden-paths-dev-demo${{ needs.golden-lane.outputs.lane == 'queue' && '-queue' || '' }}\n";

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
    ['if: false on the static job', edit(STATIC_HEADER, `${STATIC_HEADER}    if: false\n`)],
    ['if: false on the velo job', edit(VELO_HEADER, `${VELO_HEADER}    if: false\n`)],
    ['if: false on the velo gate step', edit(VELO_GATE_LINE, `${VELO_GATE_LINE}        if: false\n`)],
    ['shell override prints instead of running', edit(GATE_LINE, `${GATE_LINE}        shell: cat {0}\n`)],
    ['CI_SKIP_BUILD in the step env drops the build', edit(GATE_STEP, GATE_STEP.replace('NODE_ENV: test\n', 'NODE_ENV: test\n          CI_SKIP_BUILD: "1"\n'))],
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
    ['continue-on-error on the static job', edit(STATIC_HEADER, `${STATIC_HEADER}    continue-on-error: true\n`)],
    ['continue-on-error on the velo job', edit(VELO_HEADER, `${VELO_HEADER}    continue-on-error: true\n`)],
    ['flow-style step with continue-on-error', edit(GATE_STEP, '      - { name: CI gate, run: bun run ci static, continue-on-error: true }\n')],
    ['gate replaced by one hand-picked gate', edit(GATE_LINE, '      - run: bun run test:unit\n')],
    ['gate neutralised with || true', edit(GATE_LINE, '      - run: bun run ci static || true\n')],
    ['the velo job running the static group (browser-tests and integration never run)', edit(VELO_GATE_LINE, '        run: bun run ci static\n')],
    ['the static job running the velo group', edit(GATE_LINE, '      - run: bun run ci velo\n')],
    ['an unknown group (run-ci.sh exits 2, but the shape is refused first)', edit(VELO_GATE_LINE, '        run: bun run ci none\n')],
    // Top-level only: the jobs' own permissions blocks are indented.
    ['workflow-level env', edit('\npermissions:\n', '\nenv:\n  CI_SKIP_BUILD: "1"\n\npermissions:\n')],
    ['workflow-level defaults.run.shell', edit('\npermissions:\n', '\ndefaults:\n  run:\n    shell: cat {0}\n\npermissions:\n')],
    ['job-level env', edit(STATIC_HEADER, `${STATIC_HEADER}    env:\n      SKIP_CI: "1"\n`)],
  ];

  it.each(cases)('%s', (_label, mutated) => {
    expect(check(mutated).length).toBeGreaterThan(0);
  });

  it('the real step parked in a decoy job while quality runs one gate', () => {
    const mutated = edit(GATE_LINE, '      - run: bun run test:unit\n') + [
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
    const from = 'so 90.\n    timeout-minutes: 90\n';
    expect(check(edit(from, line === null ? 'so 90.\n' : `so 90.\n    ${line}\n`)).length).toBeGreaterThan(0);
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
    expect(check(edit(`    concurrency:\n${GOLDEN_GROUP}`, '    concurrency:\n      group: ci-${{ github.ref }}\n')).length).toBeGreaterThan(0);
  });

  it("golden-paths back on the one shared group (every PR push cancels the queue's pending run, #938)", () => {
    expect(check(edit(GOLDEN_GROUP, '      group: golden-paths-dev-demo\n')).length).toBeGreaterThan(0);
  });

  it('golden-lane taking a concurrency group (the ci- one would cancel quality)', () => {
    expect(check(edit('    name: Golden Paths lane\n', '    name: Golden Paths lane\n    concurrency:\n      group: ci-${{ github.ref }}\n')).length).toBeGreaterThan(0);
  });

  it('golden-paths concurrency removed or set to cancel', () => {
    expect(check(edit(`    concurrency:\n${GOLDEN_GROUP}      cancel-in-progress: false\n`, '')).length).toBeGreaterThan(0);
    expect(check(edit('      cancel-in-progress: false\n', '      cancel-in-progress: true\n')).length).toBeGreaterThan(0);
  });

  it('actions: write on the workflow token (any job could then cancel the run)', () => {
    expect(check(edit('permissions:\n  contents: read\n', 'permissions:\n  contents: read\n  actions: write\n')).length).toBeGreaterThan(0);
    expect(check(edit('permissions:\n  contents: read\n', 'permissions: write-all\n')).length).toBeGreaterThan(0);
    expect(check(edit('permissions:\n  contents: read\n', '')).length).toBeGreaterThan(0);
  });

  it.each([
    ['golden-paths', GOLDEN_PERMS],
    ['static', QUALITY_PERMS],
    ['velo', VELO_PERMS],
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
    ['static', QUALITY_CHECKOUT],
    ['velo', VELO_CHECKOUT],
    ['golden-paths', GOLDEN_CHECKOUT],
  ])('%s leaving its read token in .git/config (persist-credentials dropped or true)', (_job, from) => {
    expect(check(edit(from, from.replace('          persist-credentials: false\n', ''))).length).toBeGreaterThan(0);
    expect(check(edit(from, from.replace('persist-credentials: false', 'persist-credentials: true'))).length).toBeGreaterThan(0);
    expect(check(edit(from, from.replace('persist-credentials: false', "persist-credentials: 'false'"))).length).toBeGreaterThan(0);
  });

  it('CI_READ_TOKEN set to anything but the job token (the merge check trusts the API it reaches)', () => {
    expect(check(edit(GATE_STEP, GATE_STEP.replace('${{ github.token }}', '${{ secrets.OTHER }}'))).length).toBeGreaterThan(0);
  });

  it('a fourth job in ci.yml', () => {
    expect(check(`${REAL}  sidecar:\n    runs-on: [self-hosted, linux, velo]\n    concurrency:\n      group: ci-\${{ github.ref }}\n    steps:\n      - run: echo hi\n`).length).toBeGreaterThan(0);
  });

  it('runs-on a label no runner has, so the job queues forever and never goes red', () => {
    expect(check(edit(`${VELO_HEADER}    runs-on: [self-hosted, linux, velo]\n`, `${VELO_HEADER}    runs-on: [nonexistent-label]\n`)).length).toBeGreaterThan(0);
    expect(check(edit(`'"ubuntu-24.04"'`, `'"nonexistent-label"'`)).length).toBeGreaterThan(0);
    expect(check(edit('  route:\n    name: CI route\n    runs-on: [self-hosted, linux, velo]\n', '  route:\n    name: CI route\n    runs-on: [nonexistent-label]\n')).length).toBeGreaterThan(0);
  });

  it('the quality job removed or renamed', () => {
    expect(check(edit('  quality:\n', '  checks:\n')).length).toBeGreaterThan(0);
    expect(check(edit(QUALITY_HEADER, '  quality:\n    name: Type Check and Lint\n')).length).toBeGreaterThan(0);
  });
});

describe('the required check passes only when both gate groups passed', () => {
  const cases: Array<[string, string]> = [
    ['aggregator skipped when a group fails (if: success())', edit("    if: ${{ always() }}\n", '    if: ${{ success() }}\n')],
    ['aggregator without if (skipped, which counts as passing)', edit("    if: ${{ always() }}\n", '')],
    ['aggregator if: !cancelled() (a cancelled run skips the required check)', edit("    if: ${{ always() }}\n", '    if: ${{ !cancelled() }}\n')],
    ['aggregator stops waiting for velo', edit('    needs: [route, static, static-fallback, velo]\n', '    needs: [route, static, static-fallback]\n')],
    ['aggregator ignores the velo result', edit(AGGREGATE, AGGREGATE.replace(' && [ "$VELO" = "success" ]', ''))],
    ['aggregator accepts any static result', edit(AGGREGATE, AGGREGATE.replace('[ "$STATIC" = "success" ] || ', ''))],
    ['fallback runs on any static failure (a real hosted failure gets a second, green chance)', edit(FALLBACK_DECIDE, '          if false; then\n')],
    ['fallback decision neutralised', edit(FALLBACK_DECIDE, '          if [ "$job" = "never" ]; then\n')],
    ['fallback reads another job', edit('select(.name == "Static gates")', 'select(.name == "CI route")')],
    ['fallback runs when static was cancelled', edit("needs.static.result == 'failure' }}", "needs.static.result != 'success' }}")],
    ['fallback with continue-on-error', edit(FALLBACK_HEADER, `${FALLBACK_HEADER}    continue-on-error: true\n`)],
    ['fallback running another group', edit('static, on velo)\n        run: bun run ci static\n', 'static, on velo)\n        run: bun run ci velo\n')],
    ['fallback job removed from the aggregator env', edit('          FALLBACK: ${{ needs.static-fallback.result }}\n', '          FALLBACK: success\n')],
    ['aggregator accepts skipped', edit(AGGREGATE, AGGREGATE.replace('[ "$STATIC" = "success" ]', '[ "$STATIC" != "failure" ]'))],
    ['aggregator neutralised with || true', edit(AGGREGATE, AGGREGATE.replace('\n', ' || true\n'))],
    ['aggregator reads a result that is not the job\'s', edit('          VELO: ${{ needs.velo.result }}\n', "          VELO: success\n")],
    ['continue-on-error on the aggregator', edit(QUALITY_HEADER, `${QUALITY_HEADER}    continue-on-error: true\n`)],
    ['a second aggregator step that always passes', edit(AGGREGATE, `${AGGREGATE}      - run: exit 0\n`)],
    ['static timeout no longer pinned', edit("    timeout-minutes: ${{ needs.route.outputs.hosted == 'true' && 40 || 75 }}\n", '    timeout-minutes: 1\n')],
    ['static no longer needs route (its runs-on reads route\'s output)', edit('    needs: route\n', '')],
    ['a hosted setup step that runs on velo too', edit("      - if: ${{ runner.environment == 'github-hosted' }}\n        uses: actions/setup-node@v6\n", '      - uses: actions/setup-node@v6\n')],
    ['setup-bun unpinned to a moving tag', edit('oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6', 'oven-sh/setup-bun@v2')],
    ['another bun version on hosted', edit('          bun-version: 1.3.9\n', '          bun-version: latest\n')],
    ['node_modules restored from the cache', edit('          path: ~/.bun/install/cache\n', '          path: node_modules\n')],
    ['route output widened to another key', edit('      hosted: ${{ steps.route.outputs.hosted }}\n', '      hosted: ${{ steps.route.outputs.hosted }}\n      labels: x\n')],
    ['route step swaps the runner\'s bun before static runs on velo', edit('          hosted=false\n', '          cp /bin/true "$HOME/.bun/bin/bun"\n          hosted=false\n')],
    ['route step dropped (output never set)', edit('      - name: Hosted or velo?\n', '      - name: Hosted or velo?\n        if: false\n')],
    ['a decoy job named like the required check (newest run wins in the queue)', edit('    name: Golden Paths lane\n', '    name: Type Check, Lint & Test\n')],
    ['static renamed to the required check', edit('    name: Static gates\n', '    name: Type Check, Lint & Test\n')],
    ['golden-paths renamed (its required check never reports)', edit('    name: Golden Paths E2E (blocking)\n', '    name: Golden Paths E2E\n')],
    ['route taking a concurrency group', edit('    name: CI route\n', '    name: CI route\n    concurrency:\n      group: ci-${{ github.ref }}\n')],
  ];

  it.each(cases)('refuses: %s', (_label, mutated) => {
    expect(check(mutated).length).toBeGreaterThan(0);
  });
});

describe('accepts equivalent spellings of the one allowed shape', () => {
  it('a nameless step, a quoted command and a trailing comment', () => {
    expect(check(edit(GATE_LINE, '      - run: bun run ci static\n'))).toEqual([]);
    expect(check(edit(GATE_LINE, '      - run: "bun run ci static"\n'))).toEqual([]);
    expect(check(edit(GATE_LINE, '      - run: bun run ci static  # every static gate\n'))).toEqual([]);
  });

  it('static without the job permissions block, and then a checkout without inputs', () => {
    const narrow = edit(QUALITY_PERMS, QUALITY_PERMS.replace(JOB_PERMS, ''));
    expect(checkWorkflowRunsCi(load(narrow), SCRIPTS, WORKFLOW_FILES)).toEqual([]);
    const bare = narrow.replace(QUALITY_CHECKOUT, QUALITY_CHECKOUT.replace('        with:\n          fetch-depth: 0\n          persist-credentials: false\n', ''));
    expect(bare).not.toBe(narrow);
    expect(checkWorkflowRunsCi(load(bare), SCRIPTS, WORKFLOW_FILES)).toEqual([]);
  });
});
