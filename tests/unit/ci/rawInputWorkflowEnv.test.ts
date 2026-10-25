/**
 * The raw-input gate trusts two things about its environment: GITHUB_ACTIONS is the runner's own, and
 * RAW_INPUT_BASE_REF is unset. Neither can be changed from ci.yml without workflow-runs-ci (R-052) refusing the
 * change: this proves it by editing the REAL workflow the way a PR would. (A variable in the self-hosted
 * runner's own environment file is outside any workflow and outside this test.)
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { load } from 'js-yaml';
import { checkWorkflowRunsCi, WORKFLOW_FILES } from '../../../scripts/ci/workflowRunsCiRule';

const REAL = readFileSync('.github/workflows/ci.yml', 'utf8');
const SCRIPTS = (JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> }).scripts;

const check = (yamlText: string): string[] => checkWorkflowRunsCi(load(yamlText), SCRIPTS, WORKFLOW_FILES);
function edit(from: string, to: string): string {
  expect(REAL.split(from).length - 1, `anchor must occur once: ${from}`).toBe(1);
  return REAL.replace(from, to);
}

const GATE_ENV_END = '          NODE_ENV: test\n';
const QUALITY_HEADER = '  quality:\n    name: Type Check, Lint & Test\n';
const QUALITY_INSTALL = '      - name: Install dependencies\n        run: bun install --frozen-lockfile --ignore-scripts\n\n      # The gate list';
const QUALITY_CHECKOUT = '      - uses: actions/checkout@v4\n        with:\n          fetch-depth: 0\n          persist-credentials: false\n\n      # --ignore-scripts';

describe('a PR cannot reach the raw-input gate through ci.yml', () => {
  it('the committed workflow passes', () => {
    expect(check(REAL)).toEqual([]);
  });

  const cases: Array<[string, string]> = [
    ['GITHUB_ACTIONS on the gate step', edit(GATE_ENV_END, `${GATE_ENV_END}          GITHUB_ACTIONS: ""\n`)],
    ['CI on the gate step', edit(GATE_ENV_END, `${GATE_ENV_END}          CI: ""\n`)],
    ['RAW_INPUT_BASE_REF on the gate step', edit(GATE_ENV_END, `${GATE_ENV_END}          RAW_INPUT_BASE_REF: HEAD\n`)],
    ['RAW_INPUT_BASE_REF at job level', edit(QUALITY_HEADER, `${QUALITY_HEADER}    env:\n      RAW_INPUT_BASE_REF: HEAD\n`)],
    ['GITHUB_ACTIONS at job level', edit(QUALITY_HEADER, `${QUALITY_HEADER}    env:\n      GITHUB_ACTIONS: "false"\n`)],
    ['RAW_INPUT_BASE_REF at workflow level', edit('\npermissions:\n', '\nenv:\n  RAW_INPUT_BASE_REF: HEAD\n\npermissions:\n')],
    ['an env on the install step', edit(QUALITY_INSTALL, QUALITY_INSTALL.replace('--ignore-scripts\n', '--ignore-scripts\n        env:\n          RAW_INPUT_BASE_REF: HEAD\n'))],
    ['an env on the checkout step', edit(QUALITY_CHECKOUT, QUALITY_CHECKOUT.replace('persist-credentials: false\n', 'persist-credentials: false\n        env:\n          RAW_INPUT_BASE_REF: HEAD\n'))],
    [
      'a step that writes the variable to GITHUB_ENV before the gate',
      edit(QUALITY_INSTALL, '      - run: echo "RAW_INPUT_BASE_REF=HEAD" >> "$GITHUB_ENV"\n\n' + QUALITY_INSTALL),
    ],
  ];

  it.each(cases)('is refused: %s', (_name, yamlText) => {
    expect(check(yamlText).length).toBeGreaterThan(0);
  });
});
