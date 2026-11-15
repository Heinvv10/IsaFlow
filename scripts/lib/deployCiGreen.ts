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
 *   3. GitHub's check runs for HEAD (every page, count matching total_count)
 *      include each REQUIRED_JOBS name, and every run of that name is from
 *      GitHub Actions, for HEAD, completed, conclusion success. Missing,
 *      queued, in progress, failed, cancelled, skipped or neutral: full gate.
 * Any git, gh or JSON error runs the full gate. The required names live in
 * scripts/ci/mq-merge-already-tested.ts (one list; ci.yml pins the job names).
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REQUIRED_JOBS } from '../ci/mq-merge-already-tested';

export const SKIP_EXIT = 10;
export const REPO = 'Heinvv10/IsaFlow';
export const PER_PAGE = 100;
export const MAX_PAGES = 10;
const ACTIONS_APP = 'github-actions';
const SHA = /^[0-9a-f]{40}$/;

export type Verdict = { skip: boolean; reason: string; evidence: string[] };
export type Cmd = (args: string[]) => string;
export type Deps = { git: Cmd; gh: Cmd };

type CheckRun = {
  id?: unknown; name?: unknown; head_sha?: unknown; status?: unknown; conclusion?: unknown;
  app?: { slug?: unknown } | null;
};

const runCi = (reason: string, evidence: string[] = []): Verdict => ({ skip: false, reason, evidence });

/**
 * The decision on GitHub's check-runs pages for `sha`
 * (GET /repos/{repo}/commits/{sha}/check-runs, one parsed body per page).
 */
export function decide(sha: string, pages: readonly unknown[], required: readonly string[] = REQUIRED_JOBS): Verdict {
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
      evidence.push(`"${name}": ${String(r.status)}/${String(r.conclusion)} sha=${String(r.head_sha)} app=${String(slug)} id=${String(r.id)}`);
      if (r.head_sha !== sha) problems.push(`"${name}" (check run ${String(r.id)}) is for ${String(r.head_sha)}, not ${sha}`);
      else if (slug !== ACTIONS_APP) problems.push(`"${name}" (check run ${String(r.id)}) is from app ${String(slug)}, not ${ACTIONS_APP}`);
      else if (r.status !== 'completed') problems.push(`"${name}" is ${String(r.status)}, not completed`);
      else if (r.conclusion !== 'success') problems.push(`"${name}" concluded ${String(r.conclusion)}, not success`);
    }
  }
  if (problems.length > 0) return runCi(problems.join('; '), evidence);
  return { skip: true, reason: `every required check (${required.map((n) => `"${n}"`).join(', ')}) is completed/success on ${sha}`, evidence };
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
  return decide(sha, fetchPages(sha, gh));
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
  out(v.skip
    ? `[deploy-ci] GitHub CI green, skipping the local CI gate: ${v.reason}\n`
    : `[deploy-ci] running the full local CI gate: ${v.reason}\n`);
  return v.skip ? SKIP_EXIT : 0;
}

if (import.meta.main) process.exit(main());
