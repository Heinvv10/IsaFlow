/**
 * The four ci.yml jobs that together make the required "Type Check, Lint & Test"
 * check (R-052), each compared against its ONE allowed shape; see
 * workflowRunsCiRule.ts for why an exact allow-list and not a search.
 *
 *   route    GitHub-hosted (velo when repo variable CI_HOSTED=off); picks
 *            where `static` runs. Its output only chooses between the two
 *            label sets written out in static's runs-on, so a wrong value
 *            cannot strand static on a label no runner has.
 *   static   `bun run ci static`, GitHub-hosted (or velo, as route says).
 *   static-fallback  `bun run ci static` on velo, only when the hosted static
 *            job ended `failure` without ever starting (no runner, no steps:
 *            GitHub refuses hosted jobs once the Actions budget is spent).
 *   velo     `bun run ci velo`, self-hosted.
 *   quality  the required check: runs always() and passes only when route
 *            and velo concluded success and static did, itself or through
 *            static-fallback. A failed, cancelled, timed-out or skipped group
 *            makes it red, never green.
 */

export const QUALITY_JOB = 'quality';
export const QUALITY_NAME = 'Type Check, Lint & Test';
export const RUNS_ON = ['self-hosted', 'linux', 'velo'];
/**
 * The light jobs (route, quality) run where repo variable CI_HOSTED says:
 * GitHub-hosted unless it is `off`. Both label sets are written out, so no
 * value can strand them on a label no runner has.
 */
export const LIGHT_RUNS_ON = `\${{ vars.CI_HOSTED == 'off' && fromJSON('["self-hosted","linux","velo"]') || 'ubuntu-24.04' }}`;
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
const GATE_ENV = new Set(['CI_READ_TOKEN', 'DATABASE_URL', 'JWT_SECRET', 'NODE_ENV', 'TZ']);
/** Velo and production run in SAST and the date tests assert the local day; pinned so TZ cannot dodge them. */
const GATE_TZ = 'Africa/Johannesburg';
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
const STATIC_RUNS_ON = `\${{ fromJSON(${HOSTED} && '"ubuntu-24.04"' || '["self-hosted","linux","velo"]') }}`;
const STATIC_TIMEOUT = `\${{ ${HOSTED} && 40 || 75 }}`;
/**
 * route's one step. It may run on velo before static (which may run on velo
 * too), so an unpinned step could replace the runner's bun before any gate
 * ran. Pinned exactly, like quality's. It reads no repo file, so no checkout.
 */
const ROUTE_STEP_ENV = { CI_HOSTED: '${{ vars.CI_HOSTED }}' };
const ROUTE_STEP_RUN = [
  'if [ "$CI_HOSTED" = "off" ]; then',
  '  echo "[route] velo: repo variable CI_HOSTED=off"',
  '  echo "hosted=false" >> "$GITHUB_OUTPUT"',
  'else',
  '  echo "[route] GitHub-hosted"',
  '  echo "hosted=true" >> "$GITHUB_OUTPUT"',
  'fi',
].join('\n');
const HOSTED_IF = "${{ runner.environment == 'github-hosted' }}";
type HostedStep = { uses: string; with: Record<string, unknown> } | { run: string };
/**
 * The hosted-only steps before install, in order, exactly. setup-bun is pinned
 * to a commit (third-party). The apt step installs what velo has and the
 * static unit tests spawn: ghostscript (`gs`, the VLM PDF render).
 */
const HOSTED_SETUP: HostedStep[] = [
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
  { run: 'sudo apt-get update -qq\nsudo apt-get install -y -qq --no-install-recommends ghostscript' },
];
/** Hosted-only, between install and the gate: Chromium at the locked playwright's revision. */
const HOSTED_AFTER_INSTALL: HostedStep[] = [{ run: 'bunx playwright install --with-deps chromium' }];

const FALLBACK_NEEDS = ['route', 'static'];
const FALLBACK_IF = `\${{ always() && ${HOSTED} && needs.static.result == 'failure' }}`;
/** The fallback's first step: exits 1 unless the hosted job never started, so a real failure is never re-run. */
const FALLBACK_STEP_ENV = {
  GH_TOKEN: '${{ github.token }}',
  REPO: '${{ github.repository }}',
  RUN_ID: '${{ github.run_id }}',
  RUN_ATTEMPT: '${{ github.run_attempt }}',
};
const FALLBACK_STEP_RUN = [
  `job=$(gh api "repos/$REPO/actions/runs/$RUN_ID/attempts/$RUN_ATTEMPT/jobs?per_page=100" --jq '[.jobs[] | select(.name == "Static gates")] | if length == 1 then .[0] | "\\(.runner_name // "")|\\(.steps | length)" else "ambiguous" end') || job="api-error"`,
  'echo "[fallback] hosted Static gates (runner|steps): $job"',
  'if [ "$job" != "|0" ]; then',
  '  echo "::error::Static gates ran on GitHub-hosted and failed (or could not be read); no fallback for that, read its log"',
  '  exit 1',
  'fi',
  'echo "[fallback] the hosted job never started (Actions budget, billing or outage): running the static group on velo"',
].join('\n');

const QUALITY_NEEDS = ['route', 'static', 'static-fallback', 'velo'];
const QUALITY_IF = '${{ always() }}';
const QUALITY_ENV = {
  ROUTE: '${{ needs.route.result }}',
  STATIC: '${{ needs.static.result }}',
  FALLBACK: '${{ needs.static-fallback.result }}',
  VELO: '${{ needs.velo.result }}',
};
const QUALITY_RUN = [
  'echo "route=$ROUTE static=$STATIC static-fallback=$FALLBACK velo=$VELO"',
  '[ "$ROUTE" = "success" ] && [ "$VELO" = "success" ] && { [ "$STATIC" = "success" ] || [ "$FALLBACK" = "success" ]; }',
].join('\n');

export type Obj = Record<string, unknown>;
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
  if (isObj(env) && 'TZ' in env && env.TZ !== GATE_TZ) errors.push(`${at}'s TZ must be exactly ${GATE_TZ}`);
  if (isObj(env) && 'CI_READ_TOKEN' in env && env.CI_READ_TOKEN !== CI_READ_TOKEN) {
    errors.push(`${at}'s CI_READ_TOKEN must be exactly ${CI_READ_TOKEN}`);
  }
}

function checkHostedStep(step: unknown, want: HostedStep, at: string, errors: string[]): void {
  const ok = isObj(step) && step.if === HOSTED_IF && ('uses' in want
    ? !extraKeys(step, ['if', 'uses', 'with']).length && step.uses === want.uses && sameMap(step.with, want.with)
    : !extraKeys(step, ['if', 'name', 'run']).length && typeof step.run === 'string' && step.run.trim() === want.run);
  if (!ok) errors.push(`${at} must be exactly \`if: ${HOSTED_IF}\`, ${JSON.stringify(want)}`);
}

/** checkout, [hosted setup], install, [hosted browsers], `bun run ci <group>`: nothing else, in that order. */
function checkGateSteps(id: string, allSteps: unknown, group: string, hosted: boolean, errors: string[]): void {
  const run = `bun run ci ${group}`;
  const before = hosted ? HOSTED_SETUP : [];
  const after = hosted ? HOSTED_AFTER_INSTALL : [];
  const want = 3 + before.length + after.length;
  const shape = `checkout,${hosted ? ' the hosted-only setup-node/setup-bun/cache/apt steps,' : ''} \`${INSTALL}\`,${hosted ? ' the hosted-only browser install,' : ''} \`${run}\``;
  // static-fallback's pinned first step decides whether anything runs at all.
  const steps = id === 'static-fallback' && Array.isArray(allSteps) ? allSteps.slice(1) : allSteps;
  if (!Array.isArray(steps) || steps.length !== want) {
    errors.push(`jobs.${id}.steps must be exactly: ${id === 'static-fallback' ? 'the "Did the hosted job start?" step, ' : ''}${shape}`);
    return;
  }
  checkCheckout(steps[0], `jobs.${id} step 1`, errors);
  before.forEach((s, i) => checkHostedStep(steps[1 + i], s, `jobs.${id} step ${2 + i}`, errors));
  const at = 1 + before.length;
  const install = steps[at] as unknown;
  if (!isObj(install) || extraKeys(install, ['name', 'run']).length || install.run !== INSTALL) {
    errors.push(`jobs.${id} step ${at + 1} must be only \`run: ${INSTALL}\` (install scripts or a step before the gate can rewrite what it runs)`);
  }
  after.forEach((s, i) => checkHostedStep(steps[at + 1 + i], s, `jobs.${id} step ${at + 2 + i}`, errors));
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

function checkLightRunsOn(id: string, job: Obj, errors: string[]): void {
  if (job['runs-on'] !== LIGHT_RUNS_ON) {
    errors.push(`jobs.${id}.runs-on must be exactly ${LIGHT_RUNS_ON}; any other label set can queue forever and never go red`);
  }
}

function checkRoute(job: Obj, errors: string[]): void {
  const extra = extraKeys(job, ['name', 'runs-on', 'timeout-minutes', 'outputs', 'steps']);
  if (extra.length) errors.push(`jobs.route sets ${extra.join(', ')}; it may set only name, runs-on, timeout-minutes, outputs, steps`);
  checkLightRunsOn('route', job, errors);
  checkTimeout('route', job, 1, errors);
  if (!sameMap(job.outputs, { hosted: '${{ steps.route.outputs.hosted }}' })) {
    errors.push('jobs.route.outputs must be exactly {hosted: ${{ steps.route.outputs.hosted }}}');
  }
  const step = Array.isArray(job.steps) && job.steps.length === 1 ? (job.steps[0] as unknown) : undefined;
  if (!isObj(step) || extraKeys(step, ['name', 'id', 'env', 'run']).length || step.id !== 'route'
    || typeof step.run !== 'string' || step.run.trim() !== ROUTE_STEP_RUN || !sameMap(step.env, ROUTE_STEP_ENV)) {
    errors.push(`jobs.route.steps must be exactly one step with id route, env ${JSON.stringify(ROUTE_STEP_ENV)}, run:\n${ROUTE_STEP_RUN}`);
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

function checkFallback(job: Obj, errors: string[]): void {
  const extra = extraKeys(job, ['name', 'needs', 'if', 'runs-on', 'timeout-minutes', 'permissions', 'steps']);
  if (extra.length) errors.push(`jobs.static-fallback sets ${extra.join(', ')}; continue-on-error/env/strategy can skip or neutralise the gate`);
  if (!sameList(job.needs, FALLBACK_NEEDS)) errors.push(`jobs.static-fallback.needs must be exactly [${FALLBACK_NEEDS.join(', ')}]`);
  if (job.if !== FALLBACK_IF) errors.push(`jobs.static-fallback.if must be exactly ${FALLBACK_IF}`);
  checkVeloRunsOn('static-fallback', job, errors);
  checkTimeout('static-fallback', job, MIN_VELO_TIMEOUT, errors);
  const first = Array.isArray(job.steps) ? (job.steps[0] as unknown) : undefined;
  if (!isObj(first) || extraKeys(first, ['name', 'env', 'run']).length || typeof first.run !== 'string'
    || first.run.trim() !== FALLBACK_STEP_RUN || !sameMap(first.env, FALLBACK_STEP_ENV)) {
    errors.push(`jobs.static-fallback step 1 must be exactly: env ${JSON.stringify(FALLBACK_STEP_ENV)}, run:\n${FALLBACK_STEP_RUN}`);
  }
  checkGateSteps('static-fallback', job.steps, 'static', false, errors);
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
  checkLightRunsOn(QUALITY_JOB, job, errors);
  checkTimeout(QUALITY_JOB, job, MIN_QUALITY_TIMEOUT, errors);
  const steps = job.steps;
  const step = Array.isArray(steps) && steps.length === 1 ? (steps[0] as unknown) : undefined;
  if (!isObj(step) || extraKeys(step, ['name', 'env', 'run']).length || typeof step.run !== 'string'
    || step.run.trim() !== QUALITY_RUN || !sameMap(step.env, QUALITY_ENV)) {
    errors.push(`jobs.${QUALITY_JOB}.steps must be exactly one step: env ${JSON.stringify(QUALITY_ENV)}, run:\n${QUALITY_RUN}`);
  }
}

/** Checks route, static, static-fallback, velo and quality; `jobs` is ci.yml's parsed `jobs` mapping. */
export function checkGateJobs(jobs: Obj): string[] {
  const errors: string[] = [];
  const checks: Array<[string, (job: Obj, errors: string[]) => void]> = [
    ['route', checkRoute], ['static', checkStatic], ['static-fallback', checkFallback], ['velo', checkVelo],
    [QUALITY_JOB, checkQuality],
  ];
  for (const [id, check] of checks) {
    const job = jobs[id];
    if (isObj(job)) check(job, errors);
    else errors.push(`ci.yml has no jobs.${id}`);
  }
  return errors;
}
