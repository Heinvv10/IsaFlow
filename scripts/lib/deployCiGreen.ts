/**
 * deployCiGreen — deploy.sh's CI gate (section 1a) asks this whether GitHub
 * already ran every required check green on the exact commit being deployed.
 * If so the local `bun run ci` is skipped: the merge queue tested that SHA, and
 * GitHub runs the same gate list as run-ci.sh (R-052).
 *
 *   bun scripts/lib/deployCiGreen.ts
 *   exit 10: GitHub shows it green, skip the local CI gate
 *   any other exit, a crash included: run the full local CI gate
 *
 * Every condition must hold, or the full gate runs (the reason is printed):
 *   1. HEAD is a full SHA and the working tree is clean (no modified, staged or
 *      untracked file): GitHub tested the commit, not uncommitted changes.
 *   2. HEAD is on origin/master's first-parent history: a commit master was
 *      pushed to, whose checks tested that exact tree. A PR head's checks
 *      tested its merge into master, not the head on its own.
 *   3. master's branch protection requires exactly the REQUIRED_JOBS contexts:
 *      a check added to (or dropped from) protection but not to the list would
 *      otherwise never be looked at. A failed read (403 included) is not a match.
 *   4. GitHub's check runs for HEAD (every page, count matching total_count)
 *      include each REQUIRED_JOBS name, and every run of that name is from
 *      GitHub Actions, in a check suite of a push run of WORKFLOW_PATH on
 *      master for HEAD, completed, conclusion success. Missing, queued, in
 *      progress, failed, cancelled, skipped or neutral: full gate.
 * Any git, gh or JSON error runs the full gate. The required names live in
 * scripts/ci/mq-merge-already-tested.ts (one list; ci.yml pins the job names).
 * On a skip it prints `[deploy-ci] verified HEAD <sha>`; deploy.sh skips only if
 * that SHA is still HEAD, the tree still clean, and GIT_SHA a prefix of it.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REQUIRED_JOBS, WORKFLOW_PATH } from '../ci/mq-merge-already-tested';

export const SKIP_EXIT = 10;
export const REPO = 'Heinvv10/IsaFlow';
export const PER_PAGE = 100;
export const MAX_PAGES = 10;
const ACTIONS_APP = 'github-actions';
const SHA = /^[0-9a-f]{40}$/;

export type Verdict = { skip: boolean; reason: string; evidence: string[]; sha?: string };
export type Cmd = (args: string[]) => string;
export type Deps = { git: Cmd; gh: Cmd };

type CheckRun = {
  id?: unknown; name?: unknown; head_sha?: unknown; status?: unknown; conclusion?: unknown;
  app?: { slug?: unknown } | null; check_suite?: { id?: unknown } | null;
};
type WorkflowRun = { path?: unknown; event?: unknown; head_sha?: unknown; head_branch?: unknown; check_suite_id?: unknown };

const runCi = (reason: string, evidence: string[] = []): Verdict => ({ skip: false, reason, evidence });

/**
 * Why master's protection (GET .../branches/master/protection/required_status_checks)
 * does not require exactly `required`, or null when it does.
 */
export function protectionMismatch(body: unknown, required: readonly string[] = REQUIRED_JOBS): string | null {
  const contexts = (body as { contexts?: unknown } | null)?.contexts;
  if (!Array.isArray(contexts) || !contexts.every((c) => typeof c === 'string')) {
    return 'branch protection response has no list of required contexts';
  }
  const want = [...new Set(required)].sort();
  const got = [...new Set(contexts as string[])].sort();
  if (want.length === 0 || JSON.stringify(got) !== JSON.stringify(want)) {
    return `master's branch protection requires ${JSON.stringify(got)}, REQUIRED_JOBS lists ${JSON.stringify(want)}`;
  }
  return null;
}

/**
 * The check-suite ids of push runs of WORKFLOW_PATH on master for `sha`
 * (GET .../actions/runs?head_sha=), or why there are none to trust.
 */
export function ciSuiteIds(body: unknown, sha: string): { ids: ReadonlySet<number> } | { reason: string } {
  const b = body as { total_count?: unknown; workflow_runs?: unknown } | null;
  if (typeof b !== 'object' || b === null || typeof b.total_count !== 'number' || !Array.isArray(b.workflow_runs)) {
    return { reason: 'workflow-runs response is not a workflow-runs list' };
  }
  if (b.workflow_runs.length !== b.total_count) {
    return { reason: `read ${b.workflow_runs.length} of ${b.total_count} workflow runs: the list is incomplete` };
  }
  const ids = new Set<number>();
  for (const r of b.workflow_runs as WorkflowRun[]) {
    if (typeof r !== 'object' || r === null) continue;
    if (r.path === WORKFLOW_PATH && r.event === 'push' && r.head_branch === 'master' && r.head_sha === sha
      && typeof r.check_suite_id === 'number') ids.add(r.check_suite_id);
  }
  return ids.size > 0 ? { ids } : { reason: `no push run of ${WORKFLOW_PATH} on master for ${sha}` };
}

/**
 * The decision on GitHub's check-runs pages for `sha`
 * (GET /repos/{repo}/commits/{sha}/check-runs, one parsed body per page);
 * `suites` are the ci.yml check suites a required check must belong to.
 */
export function decide(sha: string, pages: readonly unknown[], suites: ReadonlySet<number>,
  required: readonly string[] = REQUIRED_JOBS): Verdict {
  if (!SHA.test(sha)) return runCi(`"${sha}" is not a full commit SHA`);
  if (required.length === 0) return runCi('no required checks are listed');
  if (pages.length === 0) return runCi('GitHub returned no check-runs page');
  const runs: CheckRun[] = [];
  let total: number | undefined;
  for (const [i, page] of pages.entries()) {
    const p = page as { total_count?: unknown; check_runs?: unknown } | null;
    if (typeof p !== 'object' || p === null || typeof p.total_count !== 'number' || !Array.isArray(p.check_runs)) {
      return runCi(`check-runs page ${i + 1} is not a check-runs response`);
    }
    if (total !== undefined && p.total_count !== total) {
      return runCi(`total_count changed between pages (${total}, then ${p.total_count}): checks were still being created`);
    }
    total = p.total_count;
    runs.push(...(p.check_runs as CheckRun[]));
  }
  if (runs.length !== total) return runCi(`read ${runs.length} of ${String(total)} check runs: the list is incomplete`);

  const evidence: string[] = [];
  const problems: string[] = [];
  for (const name of required) {
    const matches = runs.filter((r) => typeof r === 'object' && r !== null && r.name === name);
    if (matches.length === 0) {
      evidence.push(`"${name}": no check run`);
      problems.push(`"${name}" has no check run on ${sha}`);
      continue;
    }
    for (const r of matches) {
      const slug = r.app?.slug;
      const suite = r.check_suite?.id;
      evidence.push(`"${name}": ${String(r.status)}/${String(r.conclusion)} sha=${String(r.head_sha)} app=${String(slug)} suite=${String(suite)} id=${String(r.id)}`);
      if (r.head_sha !== sha) problems.push(`"${name}" (check run ${String(r.id)}) is for ${String(r.head_sha)}, not ${sha}`);
      else if (slug !== ACTIONS_APP) problems.push(`"${name}" (check run ${String(r.id)}) is from app ${String(slug)}, not ${ACTIONS_APP}`);
      else if (typeof suite !== 'number' || !suites.has(suite)) {
        problems.push(`"${name}" (check run ${String(r.id)}) is not from a push run of ${WORKFLOW_PATH} on master`);
      }
      else if (r.status !== 'completed') problems.push(`"${name}" is ${String(r.status)}, not completed`);
      else if (r.conclusion !== 'success') problems.push(`"${name}" concluded ${String(r.conclusion)}, not success`);
    }
  }
  if (problems.length > 0) return runCi(problems.join('; '), evidence);
  return { skip: true, reason: `every required check (${required.map((n) => `"${n}"`).join(', ')}) is completed/success on ${sha}`, evidence, sha };
}

/** Reads every check-runs page for `sha` with `gh api` (gh 2.45 has no --slurp, so pages are fetched one by one). */
export function fetchPages(sha: string, gh: Cmd): unknown[] {
  const pages: unknown[] = [];
  let seen = 0;
  for (let page = 1; page <= MAX_PAGES; page++) {
    // The path is one argv element (no shell), and names are matched in code, not in a query string.
    const body: unknown = JSON.parse(gh(['api', '-H', 'Accept: application/vnd.github+json',
      `repos/${REPO}/commits/${sha}/check-runs?filter=latest&per_page=${PER_PAGE}&page=${page}`]));
    pages.push(body);
    const p = body as { total_count?: unknown; check_runs?: unknown } | null;
    if (typeof p !== 'object' || p === null || !Array.isArray(p.check_runs) || typeof p.total_count !== 'number') break;
    seen += p.check_runs.length;
    if (p.check_runs.length === 0 || seen >= p.total_count) break;
  }
  return pages;
}

function check({ git, gh }: Deps): Verdict {
  const sha = git(['rev-parse', 'HEAD']).trim();
  if (!SHA.test(sha)) return runCi(`HEAD "${sha}" is not a full commit SHA`);
  const dirty = git(['status', '--porcelain', '--untracked-files=normal']).split('\n').filter((l) => l.trim() !== '');
  if (dirty.length > 0) {
    return runCi(`the working tree differs from ${sha} (${dirty.length} path(s), first: ${dirty[0]!.trim()}): GitHub never tested it`);
  }
  const mainline = git(['rev-list', '--first-parent', 'origin/master']).split('\n').map((l) => l.trim());
  if (!mainline.includes(sha)) {
    return runCi(`${sha} is not on origin/master's first-parent history: no push to master tested exactly this tree`);
  }
  const api = (path: string): unknown => JSON.parse(gh(['api', '-H', 'Accept: application/vnd.github+json', path]));
  const mismatch = protectionMismatch(api(`repos/${REPO}/branches/master/protection/required_status_checks`));
  if (mismatch) return runCi(mismatch);
  const suites = ciSuiteIds(api(`repos/${REPO}/actions/runs?head_sha=${sha}&event=push&per_page=${PER_PAGE}`), sha);
  if ('reason' in suites) return runCi(suites.reason);
  return decide(sha, fetchPages(sha, gh), suites.ids);
}

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const runner = (cmd: string): Cmd => (args) => execFileSync(cmd, args, {
  cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000, maxBuffer: 64 * 1024 * 1024,
});
const REAL_DEPS: Deps = { git: runner('git'), gh: runner('gh') };

export function main(deps: Deps = REAL_DEPS, out: (s: string) => void = (s) => process.stdout.write(s)): number {
  let v: Verdict;
  try {
    v = check(deps);
  } catch (err) {
    v = runCi(`could not check (${(err instanceof Error ? err.message : String(err)).trim().split('\n')[0]})`);
  }
  for (const line of v.evidence) out(`[deploy-ci]   ${line}\n`);
  if (v.skip && v.sha) out(`[deploy-ci] verified HEAD ${v.sha}\n`);
  out(v.skip
    ? `[deploy-ci] GitHub CI green, skipping the local CI gate: ${v.reason}\n`
    : `[deploy-ci] running the full local CI gate: ${v.reason}\n`);
  return v.skip && v.sha ? SKIP_EXIT : 0;
}

if (import.meta.main) process.exit(main());
