/**
 * mq-merge-already-tested — on a push to master, says whether the pushed
 * commit is a merge-queue merge whose exact tree already passed BOTH required
 * checks as a pull_request run. If so the push run skips its expensive work
 * (run-ci.sh exits 0 before the gates; golden-paths skips its steps), and both
 * jobs still report, green, under their own names.
 *
 *   bun scripts/ci/mq-merge-already-tested.ts
 *   exit 10: already tested, skip
 *   any other exit, a crash included: run everything
 *
 * Every condition must hold, or the full run happens (the reason is printed):
 *   1. GITHUB_EVENT_NAME=push to refs/heads/master, not forced, HEAD is the
 *      pushed `after`.
 *   2. HEAD has exactly two parents and the first is the push's `before`:
 *      one new commit on master, a merge.
 *   3. The first parent is an ancestor of the second (the queue merged master
 *      into the PR branch before testing it) and tree(HEAD) == tree(second
 *      parent): the merge added nothing the PR's head did not have.
 *   4. The subject is "Merge pull request #N from ...", and PR N is merged
 *      into master with head = the second parent and merge commit = HEAD.
 *   5. A CI run (.github/workflows/ci.yml) for event pull_request at the second
 *      parent, from PR N's head branch in this repository (not a fork's branch
 *      of the same name), has both required jobs, in their latest
 *      attempt, concluded success.
 * Why the PR run's tree is HEAD's tree: GitHub tests a PR as its merge into the
 * base of the moment, and ci.yml's pull_request trigger is pinned to base
 * master (workflowRunsCiRule), so that base was master. ASSUMED, not checked:
 * master has never been force-pushed since that run. Branch protection
 * forbids force-pushes to master (allow_force_pushes: false, enforce_admins
 * on); this script refuses a forced CURRENT push but cannot see an earlier
 * one. Under that assumption master moved only forward, so the run's base was
 * an ancestor of `before`, hence of the second parent (3), and merging an
 * ancestor changes nothing: the tested tree is the second parent's, which (3)
 * makes HEAD's. The runs API drops `pull_requests` once a PR is merged, so the
 * run is tied to PR N by its head branch, not by number.
 * A queue batch (maxBatch > 1) lands the same way: the queue merges its batch
 * PR (branch merge-queue/batch-*, built from master), so N is the batch PR.
 * The queue's `in-merge-queue` label is not used: the queue removes it once
 * the merge lands, often before this runs, and it proves nothing the tree and
 * run checks above do not.
 *
 * Token: CI_READ_TOKEN (the job's github.token, with actions: read and
 * pull-requests: read). Any API or git error runs everything.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export const SKIP_EXIT = 10;
export const WORKFLOW_PATH = '.github/workflows/ci.yml';
export const REQUIRED_JOBS = ['Type Check, Lint & Test', 'Golden Paths E2E (blocking)'];

export type Verdict = { tested: boolean; reason: string };
type Env = Record<string, string | undefined>;
export type Git = (args: string[]) => string;
export type Api = (path: string) => Promise<unknown>;

const SHA = /^[0-9a-f]{40}$/;
const SUBJECT = /^Merge pull request #(\d+) from \S+$/;

type Run = {
  id?: unknown; path?: unknown; event?: unknown; head_sha?: unknown; head_branch?: unknown;
  head_repository?: { full_name?: unknown };
};
type Job = { name?: unknown; status?: unknown; conclusion?: unknown; head_sha?: unknown };

const no = (reason: string): Verdict => ({ tested: false, reason });

/** True when `git merge-base --is-ancestor a b` exits 0; false on exit 1; throws otherwise. */
function isAncestor(git: Git, a: string, b: string): boolean {
  try {
    git(['merge-base', '--is-ancestor', a, b]);
    return true;
  } catch (err) {
    if ((err as { status?: number }).status === 1) return false;
    throw err;
  }
}

export async function decide(env: Env, event: unknown, git: Git, api: Api): Promise<Verdict> {
  if (env.GITHUB_EVENT_NAME !== 'push') return no(`event is ${env.GITHUB_EVENT_NAME ?? '(unset)'}, not push`);
  if (env.GITHUB_REF !== 'refs/heads/master') return no(`ref is ${env.GITHUB_REF ?? '(unset)'}, not refs/heads/master`);
  const e = event as { before?: unknown; after?: unknown; forced?: unknown } | null;
  if (e?.forced !== false) return no(`push is forced (or says nothing): forced=${String(e?.forced)}`);
  const before = e.before, after = e.after;
  if (typeof before !== 'string' || !SHA.test(before) || typeof after !== 'string' || !SHA.test(after)) {
    return no('the event has no before/after sha');
  }
  const head = git(['rev-parse', 'HEAD']).trim();
  if (head !== after) return no(`HEAD ${head} is not the pushed commit ${after}`);

  const parents = git(['rev-list', '--parents', '-n', '1', head]).trim().split(/\s+/).slice(1);
  if (parents.length !== 2) return no(`HEAD has ${parents.length} parent(s), not 2: not a merge`);
  const [p1, p2] = parents as [string, string];
  if (p1 !== before) return no(`first parent ${p1} is not the push's before ${before}: more than one new commit, or not a queue merge`);
  if (!isAncestor(git, p1, p2)) return no('first parent is not an ancestor of the second: master was not merged into the PR head first');
  const tree = (rev: string) => git(['rev-parse', `${rev}^{tree}`]).trim();
  if (tree(head) !== tree(p2)) return no('tree(HEAD) differs from tree(second parent): the merge added content no PR run tested');

  const subject = git(['log', '-1', '--format=%s', head]).trim();
  const m = SUBJECT.exec(subject);
  if (!m) return no(`subject "${subject}" is not "Merge pull request #N from ..."`);
  const pr = Number(m[1]);
  const repo = env.GITHUB_REPOSITORY;
  if (!repo) return no('GITHUB_REPOSITORY is unset');

  const p = (await api(`/repos/${repo}/pulls/${pr}`)) as {
    merged?: unknown; merge_commit_sha?: unknown; head?: { sha?: unknown; ref?: unknown }; base?: { ref?: unknown };
  };
  if (p.merged !== true) return no(`PR #${pr} is not merged`);
  if (p.base?.ref !== 'master') return no(`PR #${pr} was not merged into master`);
  if (p.head?.sha !== p2) return no(`PR #${pr}'s head ${String(p.head?.sha)} is not the second parent ${p2}`);
  if (p.merge_commit_sha !== head) return no(`PR #${pr}'s merge commit ${String(p.merge_commit_sha)} is not HEAD`);

  const runs = ((await api(`/repos/${repo}/actions/runs?head_sha=${p2}&event=pull_request&per_page=100`)) as {
    workflow_runs?: Run[];
  }).workflow_runs ?? [];
  const branch = p.head?.ref;
  if (typeof branch !== 'string' || branch === '') return no(`PR #${pr} has no head branch`);
  const ci = runs.filter((r) => r.path === WORKFLOW_PATH && r.event === 'pull_request' && r.head_sha === p2
    && r.head_branch === branch && r.head_repository?.full_name === repo);
  if (ci.length === 0) return no(`no pull_request CI run for ${p2} from ${branch}`);
  for (const run of ci) {
    const jobs = ((await api(`/repos/${repo}/actions/runs/${String(run.id)}/jobs?filter=latest&per_page=100`)) as {
      jobs?: Job[];
    }).jobs ?? [];
    const green = REQUIRED_JOBS.every((name) => jobs.some((j) =>
      j.name === name && j.head_sha === p2 && j.status === 'completed' && j.conclusion === 'success'));
    if (green) {
      return { tested: true, reason: `merge of PR #${pr}; its head ${p2.slice(0, 12)} has the same tree and passed both required jobs in pull_request run ${String(run.id)}` };
    }
  }
  return no(`no pull_request CI run for ${p2} has both ${REQUIRED_JOBS.map((j) => `"${j}"`).join(' and ')} green`);
}

const realGit: Git = (args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function realApi(env: Env): Api {
  const base = env.GITHUB_API_URL || 'https://api.github.com';
  return async (path) => {
    const res = await fetch(`${base}${path}`, {
      headers: { Authorization: `Bearer ${env.CI_READ_TOKEN ?? ''}`, Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`GET ${path}: HTTP ${res.status}`);
    return res.json();
  };
}

export async function main(env: Env, git: Git = realGit, api: Api = realApi(env),
  readEvent = (p: string) => readFileSync(p, 'utf8')): Promise<number> {
  let v: Verdict;
  try {
    if (!env.GITHUB_EVENT_PATH) throw new Error('GITHUB_EVENT_PATH is unset');
    v = await decide(env, JSON.parse(readEvent(env.GITHUB_EVENT_PATH)), git, api);
  } catch (err) {
    v = no(`could not check (${(err as Error).message.trim()})`);
  }
  process.stdout.write(v.tested
    ? `[mq-merge] ALREADY TESTED, skipping the full run: ${v.reason}\n`
    : `[mq-merge] full run: ${v.reason}\n`);
  return v.tested ? SKIP_EXIT : 0;
}

if (import.meta.main) process.exit(await main(process.env));
