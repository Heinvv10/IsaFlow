/**
 * The logic of scripts/ci/check-raw-input-allowlist.ts, apart from eslint and the file system, so it can be
 * unit-tested (tests/unit/ci/rawInputAllowlist.test.ts).
 *
 * The allowlist is `path -> number of rule reports` for the files that still use a raw date input or an
 * unlabelled <input>. It may only shrink: a file's count may not rise, and must be lowered (or the entry removed)
 * as soon as the file improves; entries may not be added or raised against the base ref.
 */

export type Counts = Record<string, number>;

/** Runs `git <args>` and returns stdout; throws when git exits non-zero. */
export type GitRunner = (args: string[]) => string;

export type BaseList =
  | { kind: 'list'; counts: Counts }
  | { kind: 'no-list' }
  | { kind: 'no-ref' };

export type BaseRef = { ok: true; ref: string } | { ok: false; reason: string };

/**
 * The ref the list is compared with: origin/master, or RAW_INPUT_BASE_REF for local experiments. On GitHub the
 * override is refused: a workflow (or a PR that edits one) must not be able to point the gate at a base that
 * allows more.
 */
export function resolveBaseRef(env: Record<string, string | undefined>): BaseRef {
  const override = env.RAW_INPUT_BASE_REF;
  if (override === undefined || override === '') return { ok: true, ref: 'origin/master' };
  if (env.GITHUB_ACTIONS === 'true') {
    return { ok: false, reason: `RAW_INPUT_BASE_REF is set (${override}) on GitHub. The base is always origin/master there; remove the override.` };
  }
  return { ok: true, ref: override };
}

/** Parse the JSON list; throws an Error naming `where` when it is not an object of non-negative integers. */
export function parseCounts(text: string, where: string): Counts {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`${where} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${where} must be an object of path -> count`);
  }
  const counts: Counts = Object.create(null);
  for (const [file, count] of Object.entries(raw)) {
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 1) {
      throw new Error(`${where}: "${file}" must have a positive integer count, got ${JSON.stringify(count)}`);
    }
    counts[file] = count;
  }
  return counts;
}

/**
 * The list on `ref`. Only "the ref does not exist" and "the ref has no list at that path" are soft outcomes;
 * any other git failure, or a list that does not parse, throws so the gate fails instead of waving a change through.
 */
export function readBaseList(ref: string, listPath: string, git: GitRunner): BaseList {
  try {
    git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  } catch {
    return { kind: 'no-ref' };
  }
  const listed = git(['ls-tree', '--name-only', ref, '--', listPath]).trim();
  if (listed === '') return { kind: 'no-list' };
  return { kind: 'list', counts: parseCounts(git(['show', `${ref}:${listPath}`]), `${listPath} on ${ref}`) };
}

/** Every reason the list and the tree disagree, or the list grew against `base`. Empty means the gate passes. */
export function compareCounts(listed: Counts, actual: Counts, base: Counts | null, ref: string): string[] {
  const problems: string[] = [];
  const files = [...new Set([...Object.keys(listed), ...Object.keys(actual)])].sort();
  for (const file of files) {
    const have = listed[file];
    const now = actual[file] ?? 0;
    if (have === undefined && now > 0) {
      problems.push(`NEW: ${file} has ${now} raw date input(s) or unlabelled <input>(s). Use the kit (Input, MoneyField, DateField) or label it; do not add it to the allowlist.`);
    } else if (have !== undefined && now === 0) {
      problems.push(`STALE: ${file} no longer violates (or is gone). Remove it from eslint/raw-input-allowlist.json (bun scripts/ci/check-raw-input-allowlist.ts --write).`);
    } else if (have !== undefined && now > have) {
      problems.push(`GROWN: ${file} now has ${now} (list says ${have}). A listed file may not gain raw inputs; use the kit or label them.`);
    } else if (have !== undefined && now < have) {
      problems.push(`SHRUNK: ${file} now has ${now} (list says ${have}). Lower the count (bun scripts/ci/check-raw-input-allowlist.ts --write).`);
    }
  }
  if (base !== null) {
    for (const [file, have] of Object.entries(listed)) {
      const was = base[file];
      if (was === undefined) problems.push(`ADDED: ${file} is on the list but not on ${ref}. The list may only shrink: fix the file instead.`);
      else if (have > was) problems.push(`RAISED: ${file} is ${have} on the list but ${was} on ${ref}. The list may only shrink.`);
    }
  }
  return problems;
}

/** `--write`: lower counts to what the files have now, drop the fixed ones; never add a file or raise a count. */
export function pruneCounts(listed: Counts, actual: Counts): Counts {
  const out: Counts = {};
  for (const file of Object.keys(listed).sort()) {
    const now = actual[file] ?? 0;
    if (now > 0) out[file] = Math.min(now, listed[file] as number);
  }
  return out;
}
