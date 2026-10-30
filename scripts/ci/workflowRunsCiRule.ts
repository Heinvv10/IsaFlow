/**
 * GitHub's CI job must run `bun run ci`, and must not be able to quietly skip it (R-052).
 *
 * .github/workflows/ci.yml once hand-listed five of run-ci.sh's gates, so every
 * gate added afterwards ran only locally and a PR merged green while failing
 * them. The workflow now calls run-ci.sh. This rule keeps it that way.
 *
 * WHY AN EXACT ALLOW-LIST, NOT A SEARCH. The first version grepped for a line
 * reading `run: bun run ci`. Two blind reviewers got a green job past it nine
 * different ways:
 *   - `if: false` on the step or the job;
 *   - `shell: cat {0}`;
 *   - `CI_SKIP_BUILD` in env;
 *   - an earlier step rewriting run-ci.sh;
 *   - dropping the pull_request trigger, or adding `paths-ignore`;
 *   - a quoted `"continue-on-error"`;
 *   - the line parked in a decoy job.
 * Later rounds found more: install lifecycle scripts (root, workspace member
 * or trusted dependency) rewriting run-ci.sh, which the install step's
 * `--ignore-scripts` closes as a class; pre/post hooks on `ci` or on any
 * script run-ci.sh calls, which are refused by prefix, not by name; `branches: [master, '!master']`; and a `runs-on` label no
 * runner has (queued forever, never red). All are refused below.
 * Any search admits the shape it did not think of. So the gate jobs (route,
 * static, velo and the required `quality` aggregator: workflowGateJobs.ts),
 * the triggers and package.json's `ci` script are compared against the ONE
 * shape that is known to run every gate, and anything else is refused. To
 * change a job, change this rule in the same PR, where a reviewer will see it.
 * Since 2026-10-30 the gates run in two groups (`bun run ci static` on
 * GitHub-hosted runners, `bun run ci velo` on velo); run-ci.sh still holds the
 * one list, and "Type Check, Lint & Test" passes only when both groups did.
 *
 * WHAT IT CANNOT DO:
 *   - On GitHub it runs inside the workflow it checks, so it cannot catch a
 *     workflow that stops running it. It is enforced by the local `bun run ci`
 *     and the pre-push hook.
 *   - It cannot make a red check block a merge. The repo has no required
 *     status checks; see docs/audits/remediation/R-052/fix.md.
 *   - It does not read run-ci.sh, nor the BODIES of the package scripts it
 *     calls (`"lint": "true"`). An edit there that skips a gate is a
 *     code-review matter. run-ci.sh itself skips on purpose in two places,
 *     each decided by a unit-tested script that runs everything on any doubt:
 *     every gate on a push that is an already-tested merge-queue merge
 *     (mq-merge-already-tested.ts), and the integration step on a
 *     Markdown-only change (integration/scope.ts).
 *   - It cannot protect the runner. The self-hosted runner persists between
 *     jobs and its user owns ~/.bun/bin, so any job (golden-paths, another
 *     workflow) could replace bun for every later run. A bunfig.toml preload
 *     is refused by run-ci.sh's `no-bunfig` step, in bash, not here.
 */

import {
  CHECKOUT, JOB_PERMISSIONS, QUALITY_JOB, checkGateJobs, extraKeys, isObj, sameList, sameMap,
} from './workflowGateJobs';

export { QUALITY_JOB };
export const CI_SCRIPT = 'bash scripts/ci/run-ci.sh';
/**
 * Every `bun run X` inside run-ci.sh (type-check, lint, test:unit, build, ...)
 * runs `preX`/`postX` first/after, and a pretype-check can defuse every later
 * bash gate. Naming hooks one by one is the arms race this rule exists to end,
 * so ANY pre/post-prefixed script is refused. `prepare` is the one existing
 * script with that prefix; it is an npm lifecycle name, not a hook of `pare`,
 * and --ignore-scripts keeps it from running in the job.
 */
const HOOK_PREFIX = /^(pre|post)/;
const ALLOWED_PREFIXED = new Set(['prepare']);
/**
 * A concurrency group shared with other refs ends the check CANCELLED, never
 * red, and this repo has merged on cancelled checks. Pinned exactly.
 */
const CONCURRENCY = { group: 'ci-${{ github.ref }}', 'cancel-in-progress': true };
/**
 * Concurrency groups are repo-wide, across workflows: any other job or
 * workflow that takes the ci- group cancels the gate jobs. Scanning group
 * strings is another arms race, so the SET is fixed instead: ci.yml is the
 * only workflow file, its jobs are exactly these, golden-paths keeps its own
 * group (a -queue one for runs the merge queue waits on, chosen by
 * golden-lane), and no other job takes one. A new workflow or job means
 * changing this rule in review.
 */
export const WORKFLOW_FILES = ['ci.yml'];
const JOBS = ['route', 'static', 'velo', QUALITY_JOB, 'golden-lane', 'golden-paths'];
const GOLDEN_PATHS_CONCURRENCY = {
  group: "golden-paths-dev-demo${{ needs.golden-lane.outputs.lane == 'queue' && '-queue' || '' }}",
  'cancel-in-progress': false,
};
/**
 * The token every job gets. With `actions: write` any job (golden-paths
 * included) could `gh run cancel` the run. Pinned at the top level. A job may
 * set exactly JOB_PERMISSIONS and nothing else.
 */
const PERMISSIONS = { contents: 'read' };

function checkTrigger(on: Obj, event: string, errors: string[]): void {
  const t = on[event];
  if (!isObj(t)) {
    errors.push(`on.${event} is missing; the gate must run on every ${event} to master`);
    return;
  }
  const extra = extraKeys(t, ['branches']);
  if (extra.length) errors.push(`on.${event} sets ${extra.join(', ')}; only \`branches\` is allowed (paths/types filters skip the gate)`);
  // Exactly [master]: GitHub reads a later '!master' as excluding it again.
  if (!sameList(t.branches, ['master'])) errors.push(`on.${event}.branches must be exactly [master]`);
}

/**
 * @param workflow ci.yml as parsed by js-yaml (YAML 1.2, so `on` stays a string key)
 * @param scripts package.json `scripts`
 * @param workflowFiles the file names in .github/workflows/
 * @returns one message per violation; empty means the workflow runs every gate
 */
export function checkWorkflowRunsCi(workflow: unknown, scripts: unknown, workflowFiles: string[]): string[] {
  const errors: string[] = [];
  if (!sameList([...workflowFiles].sort(), WORKFLOW_FILES)) {
    errors.push(`.github/workflows/ must hold only ${WORKFLOW_FILES.join(', ')} (it holds ${workflowFiles.join(', ') || 'nothing'}); another workflow can take the ci- concurrency group and cancel the gates`);
  }
  const pkg = isObj(scripts) ? scripts : {};
  if (pkg.ci !== CI_SCRIPT) {
    errors.push(`package.json scripts.ci must be exactly "${CI_SCRIPT}" (it is ${JSON.stringify(pkg.ci)})`);
  }
  const hooks = Object.keys(pkg).filter((k) => HOOK_PREFIX.test(k) && !ALLOWED_PREFIXED.has(k));
  if (hooks.length) errors.push(`package.json sets ${hooks.join(', ')}; bun runs pre<X>/post<X> around every \`bun run X\` inside the gate, so every pre/post-prefixed name is refused (a name that hooks nothing must be renamed, or allowed here in review)`);
  if (!isObj(workflow)) return [...errors, 'ci.yml is not a YAML mapping'];

  const topExtra = extraKeys(workflow, ['name', 'on', 'concurrency', 'permissions', 'jobs']);
  if (topExtra.length) errors.push(`ci.yml sets top-level ${topExtra.join(', ')}; env/defaults there reach the gate step`);
  const perms = workflow.permissions;
  if (!isObj(perms) || !sameList(Object.keys(perms), Object.keys(PERMISSIONS)) || perms.contents !== PERMISSIONS.contents) {
    errors.push(`ci.yml permissions must be exactly ${JSON.stringify(PERMISSIONS)}; a writable actions scope lets any job cancel the run`);
  }
  const conc = workflow.concurrency;
  if (!isObj(conc) || extraKeys(conc, Object.keys(CONCURRENCY)).length
    || conc.group !== CONCURRENCY.group || conc['cancel-in-progress'] !== CONCURRENCY['cancel-in-progress']) {
    errors.push(`ci.yml concurrency must be exactly ${JSON.stringify(CONCURRENCY)}; a group shared across refs cancels other PRs' checks instead of failing them`);
  }

  const on = workflow.on;
  if (!isObj(on)) errors.push('ci.yml has no `on` mapping');
  else {
    checkTrigger(on, 'pull_request', errors);
    checkTrigger(on, 'push', errors);
  }

  const jobs = workflow.jobs;
  if (isObj(jobs)) {
    if (!sameList(Object.keys(jobs), JOBS)) {
      errors.push(`ci.yml jobs must be exactly ${JOBS.join(', ')}; another job can take the ci- concurrency group and cancel the gates`);
    }
    const widened = Object.entries(jobs)
      .filter(([, j]) => isObj(j) && 'permissions' in j && !sameMap(j.permissions, JOB_PERMISSIONS))
      .map(([name]) => name);
    if (widened.length) errors.push(`jobs ${widened.join(', ')} set permissions other than exactly ${JSON.stringify(JOB_PERMISSIONS)}; a write scope lets a job cancel the run`);
    // A job with the wider read token must not leave it in .git/config, where
    // every later step (PR-authored tests, install scripts) can read it.
    const persisting = Object.entries(jobs)
      .filter(([, j]) => isObj(j) && 'permissions' in j && Array.isArray(j.steps) && j.steps.some((s) =>
        isObj(s) && typeof s.uses === 'string' && CHECKOUT.test(s.uses)
        && !(isObj(s.with) && s.with['persist-credentials'] === false)))
      .map(([name]) => name);
    if (persisting.length) errors.push(`jobs ${persisting.join(', ')} set permissions but check out without \`persist-credentials: false\`; the token would sit in .git/config for every later step`);
    const gp = jobs['golden-paths'];
    const gpc = isObj(gp) ? gp.concurrency : undefined;
    if (!isObj(gpc) || extraKeys(gpc, Object.keys(GOLDEN_PATHS_CONCURRENCY)).length
      || gpc.group !== GOLDEN_PATHS_CONCURRENCY.group || gpc['cancel-in-progress'] !== GOLDEN_PATHS_CONCURRENCY['cancel-in-progress']) {
      errors.push(`jobs.golden-paths.concurrency must be exactly ${JSON.stringify(GOLDEN_PATHS_CONCURRENCY)}; taking the workflow's own group deadlocks and cancels the run`);
    }
    const grouped = Object.entries(jobs).filter(([name, j]) => name !== 'golden-paths' && isObj(j) && 'concurrency' in j).map(([name]) => name);
    if (grouped.length) errors.push(`jobs ${grouped.join(', ')} set concurrency; only golden-paths may take a group (the ci- group would cancel the gates)`);
  }
  if (!isObj(jobs)) return [...errors, 'ci.yml has no `jobs` mapping'];
  errors.push(...checkGateJobs(jobs));
  return errors;
}
