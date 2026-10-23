/**
 * scope — decides whether the integration gate must run for this GitHub event.
 * run-ci.sh calls it on GitHub only (a local CI_INTEGRATION=1 always runs).
 *
 *   bun scripts/ci/integration/scope.ts
 *   exit 10: skip (every changed file is one no suite or app code can read)
 *   any other exit, a crash included: run
 *
 * The test is an ALLOW-list of what may skip, not a list of what is covered:
 * a path nobody thought of runs the gate. Only Markdown skips: the suites read
 * SQL from docs/ (docs/audits/remediation/<id>/historical-impact.sql), import
 * from tests/unit/, and read migrations and scripts, so no directory is safe
 * as a whole; no suite or app code reads a .md file.
 *
 * Changed files are what the tested tree adds to a tree that already passed
 * the gate:
 *   pull_request: the event's base sha .. HEAD (the merge commit checked out).
 *     ci.yml's pull_request trigger is pinned to base master, so the base is
 *     a master commit: one the queue merged on green required checks, or a
 *     direct push (tracking docs go straight to master) whose own push run
 *     reports any failure. In that second case a Markdown-only PR on a red
 *     master goes green without running integration: it adds no breakage,
 *     and master's own red run still shows. The payload's base sha can be
 *     older than the base the merge ref was built on; that only widens the
 *     diff (more files, more likely to run);
 *   push: the event's `before` .. HEAD, refused when forced or `before` is
 *     all zeros (a new ref has nothing to compare with).
 * --no-renames lists a rename as its deletion AND its addition, so moving
 * src/x.ts to docs/x.md cannot read as a Markdown-only change. Any other
 * event, a missing sha, a shallow history or a git failure runs the gate.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export const SKIP_EXIT = 10;

export type Scope =
  | { run: true; reason: string; triggers: string[] }
  | { run: false; reason: string };

export const skippable = (path: string): boolean => /\.md$/i.test(path);

/** The verdict for a list of changed paths. No change at all runs (nothing to prove it equal). */
export function decideScope(changed: readonly string[]): Scope {
  if (changed.length === 0) return { run: true, reason: 'no changed files found; running to be safe', triggers: [] };
  const triggers = changed.filter((f) => !skippable(f));
  if (triggers.length === 0) return { run: false, reason: `all ${changed.length} changed file(s) are Markdown` };
  return { run: true, reason: `${triggers.length} of ${changed.length} changed file(s) are not Markdown`, triggers };
}

type Env = Record<string, string | undefined>;
type Git = (args: string[]) => string;

const ZERO = /^0+$/;
const SHA = /^[0-9a-f]{40}$/;

/** The sha the tested tree is compared with, from the event payload; throws when there is none to trust. */
export function baseSha(env: Env, event: unknown): string {
  const e = event as { pull_request?: { base?: { sha?: unknown } }; before?: unknown; forced?: unknown } | null;
  let sha: unknown;
  if (env.GITHUB_EVENT_NAME === 'pull_request') sha = e?.pull_request?.base?.sha;
  else if (env.GITHUB_EVENT_NAME === 'push') {
    if (e?.forced !== false) throw new Error(`push is forced (or says nothing): forced=${String(e?.forced)}`);
    sha = e?.before;
  } else throw new Error(`event ${env.GITHUB_EVENT_NAME ?? '(unset)'} is not pull_request or push`);
  if (typeof sha !== 'string' || !SHA.test(sha) || ZERO.test(sha)) throw new Error(`no usable base sha in the event (${String(sha)})`);
  return sha;
}

/** Files changed between `base` and HEAD, renames split; throws on any git failure. */
export function changedFiles(base: string, git: Git): string[] {
  git(['cat-file', '-e', `${base}^{commit}`]);
  return git(['diff', '--name-only', '--no-renames', '-z', base, 'HEAD']).split('\0').filter(Boolean);
}

const realGit: Git = (args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

export function main(env: Env, git: Git = realGit, readEvent = (p: string) => readFileSync(p, 'utf8')): number {
  let scope: Scope;
  try {
    if (!env.GITHUB_EVENT_PATH) throw new Error('GITHUB_EVENT_PATH is unset');
    const base = baseSha(env, JSON.parse(readEvent(env.GITHUB_EVENT_PATH)));
    scope = decideScope(changedFiles(base, git));
    process.stdout.write(`[integration-scope] ${env.GITHUB_EVENT_NAME}: comparing ${base.slice(0, 12)}..HEAD\n`);
  } catch (err) {
    scope = { run: true, reason: `could not work out what changed (${(err as Error).message.trim()}); running`, triggers: [] };
  }
  if (!scope.run) {
    process.stdout.write(`[integration-scope] SKIP: ${scope.reason}\n`);
    return SKIP_EXIT;
  }
  process.stdout.write(`[integration-scope] RUN: ${scope.reason}\n`);
  const shown = scope.triggers.slice(0, 50);
  for (const f of shown) process.stdout.write(`[integration-scope]   ${f}\n`);
  if (scope.triggers.length > shown.length) process.stdout.write(`[integration-scope]   ... and ${scope.triggers.length - shown.length} more\n`);
  return 0;
}

if (import.meta.main) process.exit(main(process.env));
