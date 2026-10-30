/**
 * The four ci.yml jobs that together make the required "Type Check, Lint & Test"
 * check (R-052), each compared against its ONE allowed shape; see
 * workflowRunsCiRule.ts for why an exact allow-list and not a search.
 *
 *   route    velo; picks where `static` runs. Its output only chooses between
 *            the two label sets written out in static's runs-on, so a wrong
 *            value cannot strand static on a label no runner has.
 *   static   `bun run ci static`, GitHub-hosted (or velo, as route says).
 *   velo     `bun run ci velo`, self-hosted.
 *   quality  the required check: runs always() and passes only when route,
 *            static and velo all concluded success. A failed, cancelled,
 *            timed-out or skipped group makes it red, never green.
 */

export const QUALITY_JOB = 'quality';
export const QUALITY_NAME = 'Type Check, Lint & Test';
export const RUNS_ON = ['self-hosted', 'linux', 'velo'];
/** The read scopes mq-merge-already-tested.ts needs; a read scope cannot cancel, rerun or write. */
export const JOB_PERMISSIONS = { contents: 'read', actions: 'read', 'pull-requests': 'read' };
export const CHECKOUT = /^actions\/checkout@v\d+$/;
/**
 * The only checkout inputs allowed: full history (the integration scope and the
 * merge check read it), and no token left in .git/config, where any test or
 * install script could read it.
 */
const CHECKOUT_WITH = { 'fetch-depth': 0, 'persist-credentials': false };
const INSTALL = 'bun install --frozen-lockfile --ignore-scripts';
/** The only env a gate step may set. CI_SKIP_BUILD / SKIP_CI would drop gates silently. */
const GATE_ENV = new Set(['CI_READ_TOKEN', 'DATABASE_URL', 'JWT_SECRET', 'NODE_ENV']);
/** CI_READ_TOKEN must be the job's own token: the merge check trusts what the API answers. */
const CI_READ_TOKEN = '${{ github.token }}';
/**
 * A timeout too short to finish ends the job cancelled. quality turns that red,
 * but a red check that only ever times out blocks every PR, so velo keeps a
 * floor (integration measured 18 min at load ~40, 2026-10-30).
 */
const MIN_VELO_TIMEOUT = 20;
const MIN_QUALITY_TIMEOUT = 2;

const HOSTED = "needs.route.outputs.hosted == 'true'";
const STATIC_RUNS_ON = `\${{ fromJSON(${HOSTED} && '"ubuntu-latest"' || '["self-hosted","linux","velo"]') }}`;
const STATIC_TIMEOUT = `\${{ ${HOSTED} && 30 || 75 }}`;
const HOSTED_IF = "${{ runner.environment == 'github-hosted' }}";
/** The hosted-only setup steps, in order, exactly. setup-bun is pinned to a commit (third-party). */
const HOSTED_SETUP: Array<{ uses: string; with: Record<string, unknown> }> = [
  { uses: 'actions/setup-node@v6', with: { 'node-version': 20 } },
  { uses: 'oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6', with: { 'bun-version': '1.3.9' } },
  {
    uses: 'actions/cache@v4',
    with: {
      path: '~/.bun/install/cache',
      key: "bun-${{ runner.os }}-${{ hashFiles('bun.lock') }}",
      'restore-keys': 'bun-${{ runner.os }}-',
    },
  },
];

const QUALITY_NEEDS = ['route', 'static', 'velo'];
const QUALITY_IF = '${{ always() }}';
const QUALITY_ENV = {
  ROUTE: '${{ needs.route.result }}',
  STATIC: '${{ needs.static.result }}',
  VELO: '${{ needs.velo.result }}',
};
const QUALITY_RUN = [
  'echo "route=$ROUTE static=$STATIC velo=$VELO"',
  '[ "$ROUTE" = "success" ] && [ "$STATIC" = "success" ] && [ "$VELO" = "success" ]',
].join('\n');

type Obj = Record<string, unknown>;
export const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

export function sameList(v: unknown, want: string[]): boolean {
  return Array.isArray(v) && v.length === want.length && v.every((x, i) => x === want[i]);
}

export function extraKeys(o: Obj, allowed: string[]): string[] {
  return Object.keys(o).filter((k) => !allowed.includes(k));
}

export function sameMap(v: unknown, want: Record<string, unknown>): boolean {
  return isObj(v) && sameList(Object.keys(v).sort(), Object.keys(want).sort())
    && Object.entries(want).every(([k, x]) => v[k] === x);
}

function checkCheckout(step: unknown, at: string, errors: string[]): void {
  if (!isObj(step) || extraKeys(step, ['uses', 'with']).length || typeof step.uses !== 'string'
    || !CHECKOUT.test(step.uses) || (step.with !== undefined && !sameMap(step.with, CHECKOUT_WITH))) {
    errors.push(`${at} must be only \`uses: actions/checkout@vN\`, optionally \`with: {fetch-depth: 0, persist-credentials: false}\``);
  }
}

function checkGateStep(step: unknown, run: string, at: string, errors: string[]): void {
  if (!isObj(step) || extraKeys(step, ['name', 'run', 'env']).length || typeof step.run !== 'string' || step.run.trim() !== run) {
    errors.push(`${at} must be only \`run: ${run}\` (+ name, env); if/shell/continue-on-error/working-directory are refused`);
    return;
  }
  if (step.env === undefined) return;
  const env = step.env;
  const bad = isObj(env) ? Object.keys(env).filter((k) => !GATE_ENV.has(k)) : ['<not a mapping>'];
  if (bad.length) errors.push(`${at}'s env sets ${bad.join(', ')}; only ${[...GATE_ENV].join(', ')} are allowed`);
  if (isObj(env) && 'CI_READ_TOKEN' in env && env.CI_READ_TOKEN !== CI_READ_TOKEN) {
    errors.push(`${at}'s CI_READ_TOKEN must be exactly ${CI_READ_TOKEN}`);
  }
}

/** checkout, [hosted setup], install, `bun run ci <group>`: nothing else, in that order. */
function checkGateSteps(id: string, steps: unknown, group: string, hostedSetup: boolean, errors: string[]): void {
  const run = `bun run ci ${group}`;
  const want = 3 + (hostedSetup ? HOSTED_SETUP.length : 0);
  const shape = `checkout,${hostedSetup ? ' the hosted-only setup-node/setup-bun/cache steps,' : ''} \`${INSTALL}\`, \`${run}\``;
  if (!Array.isArray(steps) || steps.length !== want) {
    errors.push(`jobs.${id}.steps must be exactly: ${shape}`);
    return;
  }
  checkCheckout(steps[0], `jobs.${id} step 1`, errors);
  if (hostedSetup) {
    HOSTED_SETUP.forEach((s, i) => {
      const step = steps[1 + i] as unknown;
      if (!isObj(step) || extraKeys(step, ['if', 'uses', 'with']).length || step.if !== HOSTED_IF
        || step.uses !== s.uses || !sameMap(step.with, s.with)) {
        errors.push(`jobs.${id} step ${2 + i} must be exactly \`if: ${HOSTED_IF}\`, \`uses: ${s.uses}\`, with ${JSON.stringify(s.with)}`);
      }
    });
  }
  const install = steps[want - 2] as unknown;
  if (!isObj(install) || extraKeys(install, ['name', 'run']).length || install.run !== INSTALL) {
    errors.push(`jobs.${id} step ${want - 1} must be only \`run: ${INSTALL}\` (install scripts or a step before the gate can rewrite what it runs)`);
  }
  checkGateStep(steps[want - 1], run, `jobs.${id} gate step`, errors);
}

function checkTimeout(id: string, job: Obj, min: number, errors: string[]): void {
  const t = job['timeout-minutes'];
  if (!Number.isInteger(t) || (t as number) < min) {
    errors.push(`jobs.${id}.timeout-minutes must be an integer >= ${min}; a job that cannot finish ends cancelled`);
  }
}

function checkVeloRunsOn(id: string, job: Obj, errors: string[]): void {
  if (!sameList(job['runs-on'], RUNS_ON)) {
    errors.push(`jobs.${id}.runs-on must be exactly [${RUNS_ON.join(', ')}]; an unknown label queues forever and never goes red`);
  }
}

function checkRoute(job: Obj, errors: string[]): void {
  const extra = extraKeys(job, ['name', 'runs-on', 'timeout-minutes', 'outputs', 'steps']);
  if (extra.length) errors.push(`jobs.route sets ${extra.join(', ')}; it may set only name, runs-on, timeout-minutes, outputs, steps`);
  checkVeloRunsOn('route', job, errors);
  checkTimeout('route', job, 1, errors);
  if (!sameMap(job.outputs, { hosted: '${{ steps.route.outputs.hosted }}' })) {
    errors.push('jobs.route.outputs must be exactly {hosted: ${{ steps.route.outputs.hosted }}}');
  }
}

function checkStatic(job: Obj, errors: string[]): void {
  const extra = extraKeys(job, ['name', 'needs', 'runs-on', 'timeout-minutes', 'permissions', 'steps']);
  if (extra.length) errors.push(`jobs.static sets ${extra.join(', ')}; if/continue-on-error/defaults/env/strategy can skip or neutralise the gate`);
  if (job.needs !== 'route') errors.push('jobs.static.needs must be exactly `route`');
  if (job['runs-on'] !== STATIC_RUNS_ON) {
    errors.push(`jobs.static.runs-on must be exactly ${STATIC_RUNS_ON}; any other label set can queue forever and never go red`);
  }
  if (job['timeout-minutes'] !== STATIC_TIMEOUT) errors.push(`jobs.static.timeout-minutes must be exactly ${STATIC_TIMEOUT}`);
  checkGateSteps('static', job.steps, 'static', true, errors);
}

function checkVelo(job: Obj, errors: string[]): void {
  const extra = extraKeys(job, ['name', 'runs-on', 'timeout-minutes', 'permissions', 'steps']);
  if (extra.length) errors.push(`jobs.velo sets ${extra.join(', ')}; if/continue-on-error/defaults/env/strategy can skip or neutralise the gate`);
  checkVeloRunsOn('velo', job, errors);
  checkTimeout('velo', job, MIN_VELO_TIMEOUT, errors);
  checkGateSteps('velo', job.steps, 'velo', false, errors);
}

function checkQuality(job: Obj, errors: string[]): void {
  const extra = extraKeys(job, ['name', 'needs', 'if', 'runs-on', 'timeout-minutes', 'steps']);
  if (extra.length) errors.push(`jobs.${QUALITY_JOB} sets ${extra.join(', ')}; continue-on-error/env/permissions/strategy can turn a red group green`);
  if (job.name !== QUALITY_NAME) errors.push(`jobs.${QUALITY_JOB}.name must be exactly "${QUALITY_NAME}" (the required check)`);
  if (!sameList(job.needs, QUALITY_NEEDS)) errors.push(`jobs.${QUALITY_JOB}.needs must be exactly [${QUALITY_NEEDS.join(', ')}]`);
  if (job.if !== QUALITY_IF) {
    errors.push(`jobs.${QUALITY_JOB}.if must be exactly ${QUALITY_IF}; skipped, the required check counts as passed`);
  }
  checkVeloRunsOn(QUALITY_JOB, job, errors);
  checkTimeout(QUALITY_JOB, job, MIN_QUALITY_TIMEOUT, errors);
  const steps = job.steps;
  const step = Array.isArray(steps) && steps.length === 1 ? (steps[0] as unknown) : undefined;
  if (!isObj(step) || extraKeys(step, ['name', 'env', 'run']).length || typeof step.run !== 'string'
    || step.run.trim() !== QUALITY_RUN || !sameMap(step.env, QUALITY_ENV)) {
    errors.push(`jobs.${QUALITY_JOB}.steps must be exactly one step: env ${JSON.stringify(QUALITY_ENV)}, run:\n${QUALITY_RUN}`);
  }
}

/** Checks route, static, velo and quality; `jobs` is ci.yml's parsed `jobs` mapping. */
export function checkGateJobs(jobs: Obj): string[] {
  const errors: string[] = [];
  const checks: Array<[string, (job: Obj, errors: string[]) => void]> = [
    ['route', checkRoute], ['static', checkStatic], ['velo', checkVelo], [QUALITY_JOB, checkQuality],
  ];
  for (const [id, check] of checks) {
    const job = jobs[id];
    if (isObj(job)) check(job, errors);
    else errors.push(`ci.yml has no jobs.${id}`);
  }
  return errors;
}
