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
 * Any search admits the shape it did not think of. So the `quality` job, its
 * triggers and package.json's `ci` script are compared against the ONE shape
 * that is known to run every gate, and anything else is refused. To change
 * the job, change this rule in the same PR, where a reviewer will see it.
 *
 * WHAT IT CANNOT DO:
 *   - On GitHub it runs inside the workflow it checks, so it cannot catch a
 *     workflow that stops running it. It is enforced by the local `bun run ci`
 *     and the pre-push hook.
 *   - It cannot make a red check block a merge. The repo has no required
 *     status checks; see docs/audits/remediation/R-052/fix.md.
 *   - It does not read run-ci.sh, nor the BODIES of the package scripts it
 *     calls (`"lint": "true"`). An edit there that skips a gate is a
 *     code-review matter.
 *   - It cannot protect the runner. The self-hosted runner persists between
 *     jobs and its user owns ~/.bun/bin, so any job (golden-paths, another
 *     workflow) could replace bun for every later run. A bunfig.toml preload
 *     is refused by run-ci.sh's `no-bunfig` step, in bash, not here.
 */

export const QUALITY_JOB = 'quality';
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
const RUNS_ON = ['self-hosted', 'linux', 'velo'];
/**
 * A timeout too short to finish, or a concurrency group shared with other
 * refs, ends the check CANCELLED, never red, and this repo has merged on
 * cancelled checks. Concurrency is pinned exactly; the timeout has a floor
 * (the job measured 8m13s under load, R-052/green.log).
 */
const CONCURRENCY = { group: 'ci-${{ github.ref }}', 'cancel-in-progress': true };
const MIN_TIMEOUT_MINUTES = 20;
const CHECKOUT = /^actions\/checkout@v\d+$/;
const INSTALL = 'bun install --frozen-lockfile --ignore-scripts';
const RUN_CI = 'bun run ci';
/** The only env the gate step may set. CI_SKIP_BUILD / SKIP_CI would drop gates silently. */
const GATE_ENV = new Set(['DATABASE_URL', 'JWT_SECRET', 'NODE_ENV']);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function sameList(v: unknown, want: string[]): boolean {
  return Array.isArray(v) && v.length === want.length && v.every((x, i) => x === want[i]);
}

function extraKeys(o: Obj, allowed: string[]): string[] {
  return Object.keys(o).filter((k) => !allowed.includes(k));
}

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
 * @returns one message per violation; empty means the workflow runs every gate
 */
export function checkWorkflowRunsCi(workflow: unknown, scripts: unknown): string[] {
  const errors: string[] = [];
  const pkg = isObj(scripts) ? scripts : {};
  if (pkg.ci !== CI_SCRIPT) {
    errors.push(`package.json scripts.ci must be exactly "${CI_SCRIPT}" (it is ${JSON.stringify(pkg.ci)})`);
  }
  const hooks = Object.keys(pkg).filter((k) => HOOK_PREFIX.test(k) && !ALLOWED_PREFIXED.has(k));
  if (hooks.length) errors.push(`package.json sets ${hooks.join(', ')}; bun runs pre<X>/post<X> around every \`bun run X\` inside the gate, so every pre/post-prefixed name is refused (a name that hooks nothing must be renamed, or allowed here in review)`);
  if (!isObj(workflow)) return [...errors, 'ci.yml is not a YAML mapping'];

  const topExtra = extraKeys(workflow, ['name', 'on', 'concurrency', 'permissions', 'jobs']);
  if (topExtra.length) errors.push(`ci.yml sets top-level ${topExtra.join(', ')}; env/defaults there reach the gate step`);
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
  const job = isObj(jobs) ? jobs[QUALITY_JOB] : undefined;
  if (!isObj(job)) return [...errors, `ci.yml has no jobs.${QUALITY_JOB}`];

  const jobExtra = extraKeys(job, ['name', 'runs-on', 'timeout-minutes', 'steps']);
  if (jobExtra.length) errors.push(`jobs.${QUALITY_JOB} sets ${jobExtra.join(', ')}; if/continue-on-error/defaults/env/strategy can skip or neutralise the gate`);
  const timeout = job['timeout-minutes'];
  if (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout < MIN_TIMEOUT_MINUTES) {
    errors.push(`jobs.${QUALITY_JOB}.timeout-minutes must be an integer >= ${MIN_TIMEOUT_MINUTES}; a job that cannot finish ends cancelled, never red`);
  }

  if (!sameList(job['runs-on'], RUNS_ON)) {
    errors.push(`jobs.${QUALITY_JOB}.runs-on must be exactly [${RUNS_ON.join(', ')}]; an unknown label queues forever and never goes red`);
  }

  const steps = job.steps;
  if (!Array.isArray(steps) || steps.length !== 3) {
    return [...errors, `jobs.${QUALITY_JOB}.steps must be exactly: checkout, \`${INSTALL}\`, \`${RUN_CI}\``];
  }
  const [checkout, install, gate] = steps as unknown[];

  if (!isObj(checkout) || extraKeys(checkout, ['uses']).length || typeof checkout.uses !== 'string' || !CHECKOUT.test(checkout.uses)) {
    errors.push('step 1 must be only `uses: actions/checkout@vN`');
  }
  if (!isObj(install) || extraKeys(install, ['name', 'run']).length || install.run !== INSTALL) {
    errors.push(`step 2 must be only \`run: ${INSTALL}\` (install scripts or a step before the gate can rewrite what it runs)`);
  }
  if (!isObj(gate) || extraKeys(gate, ['name', 'run', 'env']).length || typeof gate.run !== 'string' || gate.run.trim() !== RUN_CI) {
    errors.push(`step 3 must be only \`run: ${RUN_CI}\` (+ name, env); if/shell/continue-on-error/working-directory are refused`);
  } else if (gate.env !== undefined) {
    const env = gate.env;
    const bad = isObj(env) ? Object.keys(env).filter((k) => !GATE_ENV.has(k)) : ['<not a mapping>'];
    if (bad.length) errors.push(`the gate step's env sets ${bad.join(', ')}; only ${[...GATE_ENV].join(', ')} are allowed`);
  }
  return errors;
}
