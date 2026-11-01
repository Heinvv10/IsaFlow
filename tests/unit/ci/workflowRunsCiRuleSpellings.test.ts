/**
 * workflowRunsCiRule (R-052) accepts equivalent spellings of the one allowed
 * shape. Split from workflowRunsCiRule.test.ts, which holds the refusals.
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { load } from 'js-yaml';
import { checkWorkflowRunsCi, WORKFLOW_FILES } from '../../../scripts/ci/workflowRunsCiRule';

const REAL = readFileSync('.github/workflows/ci.yml', 'utf8');
const SCRIPTS = (JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> }).scripts;
const GATE_LINE = '      - name: CI gate (scripts/ci/run-ci.sh static)\n        run: bun run ci static\n';
const QUALITY_CHECKOUT = '      - uses: actions/checkout@v4\n        with:\n          fetch-depth: 0\n          persist-credentials: false\n\n      # GitHub-hosted only';
const JOB_PERMS = '    permissions:\n      contents: read\n      actions: read\n      pull-requests: read\n';
const QUALITY_PERMS = `merged PR and its CI run's jobs (CI_READ_TOKEN below).\n${JOB_PERMS}`;

const check = (yamlText: string): string[] => checkWorkflowRunsCi(load(yamlText), SCRIPTS, WORKFLOW_FILES);
function edit(from: string, to: string): string {
  expect(REAL.split(from).length - 1, `fixture anchor must occur once: ${from}`).toBe(1);
  return REAL.replace(from, to);
}

describe('accepts equivalent spellings of the one allowed shape', () => {
  it('a nameless step, a quoted command and a trailing comment', () => {
    expect(check(edit(GATE_LINE, '      - run: bun run ci static\n'))).toEqual([]);
    expect(check(edit(GATE_LINE, '      - run: "bun run ci static"\n'))).toEqual([]);
    expect(check(edit(GATE_LINE, '      - run: bun run ci static  # every static gate\n'))).toEqual([]);
  });

  it('static without the job permissions block, and then a checkout without inputs', () => {
    const narrow = edit(QUALITY_PERMS, QUALITY_PERMS.replace(JOB_PERMS, ''));
    expect(check(narrow)).toEqual([]);
    const bare = narrow.replace(QUALITY_CHECKOUT, QUALITY_CHECKOUT.replace('        with:\n          fetch-depth: 0\n          persist-credentials: false\n', ''));
    expect(bare).not.toBe(narrow);
    expect(check(bare)).toEqual([]);
  });
});
