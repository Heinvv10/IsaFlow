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

// static's gate env ends where the velo job's comment starts (velo has the same env).
const VELO_NEXT = '\n  # `bun run ci velo`';
const GATE_ENV_END = `          NODE_ENV: test\n${VELO_NEXT}`;
const QUALITY_HEADER = '  static:\n    name: Static gates\n';
const QUALITY_INSTALL = '      - name: Install dependencies\n        run: bun install --frozen-lockfile --ignore-scripts\n\n      # Chromium for';
const QUALITY_CHECKOUT = '      - uses: actions/checkout@v4\n        with:\n          fetch-depth: 0\n          persist-credentials: false\n\n      # GitHub-hosted only';

describe('a PR cannot reach the raw-input gate through ci.yml', () => {
  it('the committed workflow passes', () => {
    expect(check(REAL)).toEqual([]);
  });

  // [what the PR does, the edited workflow, what the refusal must say]: the message names the variable or the step.
  const cases: Array<[string, string, RegExp]> = [
    ['GITHUB_ACTIONS on the gate step', edit(GATE_ENV_END, `          NODE_ENV: test\n          GITHUB_ACTIONS: ""\n${VELO_NEXT}`), /gate step's env sets GITHUB_ACTIONS;/],
    ['CI on the gate step', edit(GATE_ENV_END, `          NODE_ENV: test\n          CI: ""\n${VELO_NEXT}`), /gate step's env sets CI;/],
    ['RAW_INPUT_BASE_REF on the gate step', edit(GATE_ENV_END, `          NODE_ENV: test\n          RAW_INPUT_BASE_REF: HEAD\n${VELO_NEXT}`), /gate step's env sets RAW_INPUT_BASE_REF;/],
    ['RAW_INPUT_BASE_REF at job level', edit(QUALITY_HEADER, `${QUALITY_HEADER}    env:\n      RAW_INPUT_BASE_REF: HEAD\n`), /jobs\.static sets env;/],
    ['GITHUB_ACTIONS at job level', edit(QUALITY_HEADER, `${QUALITY_HEADER}    env:\n      GITHUB_ACTIONS: "false"\n`), /jobs\.static sets env;/],
    ['RAW_INPUT_BASE_REF at workflow level', edit('\npermissions:\n', '\nenv:\n  RAW_INPUT_BASE_REF: HEAD\n\npermissions:\n'), /ci\.yml sets top-level env;/],
    [
      'an env on the install step',
      edit(QUALITY_INSTALL, QUALITY_INSTALL.replace('--ignore-scripts\n', '--ignore-scripts\n        env:\n          RAW_INPUT_BASE_REF: HEAD\n')),
      /^jobs\.static step 6 must be only `run: bun install --frozen-lockfile --ignore-scripts`/,
    ],
    [
      'an env on the checkout step',
      edit(QUALITY_CHECKOUT, QUALITY_CHECKOUT.replace('persist-credentials: false\n', 'persist-credentials: false\n        env:\n          RAW_INPUT_BASE_REF: HEAD\n')),
      /^jobs\.static step 1 must be only `uses: actions\/checkout@vN`/,
    ],
    [
      'a step that writes the variable to GITHUB_ENV before the gate',
      edit(QUALITY_INSTALL, '      - run: echo "RAW_INPUT_BASE_REF=HEAD" >> "$GITHUB_ENV"\n\n' + QUALITY_INSTALL),
      /^jobs\.static\.steps must be exactly: checkout, the hosted-only setup-node\/setup-bun\/cache\/apt steps, `bun install --frozen-lockfile --ignore-scripts`, the hosted-only browser install, `bun run ci static`/,
    ],
  ];

  it.each(cases)('is refused, and the message names the cause: %s', (_name, yamlText, message) => {
    const errors = check(yamlText);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(message);
  });
});
