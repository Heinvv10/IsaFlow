/**
 * check-workflow-runs-ci — CI entrypoint for R-052: GitHub's `quality` job
 * must run `bun run ci`, in the one shape that cannot skip a gate.
 *
 * The rule lives in ./workflowRunsCiRule.ts; see its header for why it is an
 * exact allow-list, and tests/unit/ci/workflowRunsCiRule.test.ts for every
 * bypass it refuses.
 *
 * Run: bun scripts/ci/check-workflow-runs-ci.ts
 */

import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import { checkWorkflowRunsCi } from './workflowRunsCiRule';

const WORKFLOW = '.github/workflows/ci.yml';

let errors: string[];
try {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts?: Record<string, unknown> };
  errors = checkWorkflowRunsCi(load(readFileSync(WORKFLOW, 'utf8')), pkg.scripts?.ci);
} catch (err) {
  errors = [`could not read ${WORKFLOW} or package.json: ${(err as Error).message}`];
}

if (errors.length) {
  process.stderr.write(`ERROR: ${WORKFLOW} does not run every CI gate:\n${errors.map((e) => `  - ${e}`).join('\n')}\n`);
  process.exit(1);
}
process.stdout.write(`${WORKFLOW}: jobs.quality runs \`bun run ci\` with nothing able to skip it\n`);
