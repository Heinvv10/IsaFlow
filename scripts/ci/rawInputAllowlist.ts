/**
 * The logic of scripts/ci/check-raw-input-allowlist.ts, apart from eslint and the file system, so it can be
 * unit-tested (tests/unit/ci/rawInputAllowlist.test.ts).
 *
 * Each allowlist is `path -> number of rule reports`: eslint/raw-input-allowlist.json for a raw date input or an
 * unlabelled <input> (isaflow/no-raw-form-input), eslint/unnamed-control-allowlist.json for an unnamed <select>
 * or <textarea> (isaflow/no-unnamed-control). Each may only shrink: a file's count may not rise, and must be
 * lowered (or the entry removed) as soon as the file improves; entries may not be added or raised against the
 * base ref. A list that is absent on the base ref is being introduced, so it is created once at its measured size.
 */

export type Counts = Record<string, number>;

/** One allowlist and the words its messages use. */
export interface ListSpec {
  path: string;
  tag: string;
  /** What a report is, for NEW: "raw date input(s) or unlabelled <input>(s)". */
  what: string;
  /** How to fix one, for NEW and GROWN. */
  fix: string;
}

export const RAW_INPUT_LIST: ListSpec = {
  path: 'eslint/raw-input-allowlist.json',
  tag: '[raw-input-allowlist]',
  what: 'raw date input(s) or unlabelled <input>(s)',
  fix: 'Use the kit (Input, MoneyField, DateField) or label it',
};

export const UNNAMED_CONTROL_LIST: ListSpec = {
  path: 'eslint/unnamed-control-allowlist.json',
  tag: '[unnamed-control-allowlist]',
  what: 'unnamed <select>/<textarea>(s)',
  fix: 'Use the kit (Select, Textarea), or name it with htmlFor/id or aria-label',
};

/** Runs `git <args>` and returns stdout; throws when git exits non-zero. */
export type GitRunner = (args: string[]) => string;

export type BaseList =
  | { kind: 'list'; counts: Counts }
  | { kind: 'no-list' }
  | { kind: 'no-ref' };

/**
 * Is this a CI run? Any non-empty GITHUB_ACTIONS or CI counts, whatever the value ("true", "1", "True",
 * even "false"): the check must not be switchable off by spelling. GitHub sets GITHUB_ACTIONS=true on every run
 * and the quality job's workflow rule refuses a step env that could override it.
 */
export function isCI(env: Record<string, string | undefined>): boolean {
  return ['GITHUB_ACTIONS', 'CI'].some((key) => (env[key] ?? '') !== '');
}

export type BaseRef = { ok: true; ref: string } | { ok: false; reason: string };

/**
 * The ref the list is compared with: origin/master, or RAW_INPUT_BASE_REF for local experiments. In CI the
 * override is refused: a workflow (or a PR that edits one) must not be able to point the gate at a base that
 * allows more.
 */
export function resolveBaseRef(env: Record<string, string | undefined>): BaseRef {
  const override = env.RAW_INPUT_BASE_REF;
  if (override === undefined || override === '') return { ok: true, ref: 'origin/master' };
  if (isCI(env)) {
    return { ok: false, reason: `RAW_INPUT_BASE_REF is set (${override}) in CI. The base is always origin/master there; remove the override.` };
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
export function compareCounts(listed: Counts, actual: Counts, base: Counts | null, ref: string, list: ListSpec = RAW_INPUT_LIST): string[] {
  const problems: string[] = [];
  const files = [...new Set([...Object.keys(listed), ...Object.keys(actual)])].sort();
  for (const file of files) {
    const have = listed[file];
    const now = actual[file] ?? 0;
    if (have === undefined && now > 0) {
      problems.push(`NEW: ${file} has ${now} ${list.what}. ${list.fix}; do not add it to the allowlist.`);
    } else if (have !== undefined && now === 0) {
      problems.push(`STALE: ${file} no longer violates (or is gone). Remove it from ${list.path} (bun scripts/ci/check-raw-input-allowlist.ts --write).`);
    } else if (have !== undefined && now > have) {
      problems.push(`GROWN: ${file} now has ${now} (list says ${have}). A listed file may not gain more. ${list.fix}.`);
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

/** Everything the gate touches outside this module, so `runGate` can be driven by fakes in a test. */
export interface GateDeps {
  env: Record<string, string | undefined>;
  /** True for `--write`. */
  writing: boolean;
  git: GitRunner;
  /** Reports per file with the allowlist emptied (the ESLint run). */
  actualCounts: () => Promise<Counts>;
  /** The committed list's text, or null when the file does not exist. */
  readList: () => string | null;
  writeList: (counts: Counts) => void;
  log: (line: string) => void;
  error: (line: string) => void;
  /** Which list this run checks; RAW_INPUT_LIST when omitted. */
  list?: ListSpec;
}

/** The whole gate; returns the process exit code. The base ref is settled BEFORE the slow ESLint run. */
export async function runGate(deps: GateDeps): Promise<number> {
  const { env, git, log, error } = deps;
  const list = deps.list ?? RAW_INPUT_LIST;
  const { path: listPath, tag } = list;
  // Refused in CI for `--write` too: it does not read the base, but a CI that sets the override is wrong either way.
  const resolved = resolveBaseRef(env);
  if (!resolved.ok) {
    error(`${tag} FAIL: ${resolved.reason}`);
    return 1;
  }
  const ref = resolved.ref;

  const text = deps.readList();
  if (text === null) {
    if (!deps.writing) {
      error(`${tag} ${listPath} is missing`);
      return 1;
    }
    const fresh = await deps.actualCounts();
    deps.writeList(fresh);
    log(`${tag} wrote ${Object.keys(fresh).length} entries`);
    return 0;
  }
  const listed = parseCounts(text, listPath);

  const actual = await deps.actualCounts();
  if (deps.writing) {
    const pruned = pruneCounts(listed, actual);
    deps.writeList(pruned);
    const stillBad = compareCounts(pruned, actual, null, '', list).filter((p) => !p.startsWith('SHRUNK'));
    log(`${tag} pruned: ${Object.keys(pruned).length} files left`);
    stillBad.forEach((p) => error(`${tag} ${p}`));
    return stillBad.length > 0 ? 1 : 0;
  }

  const base = readBaseList(ref, listPath, git);
  if (base.kind === 'no-ref') {
    const where = isCI(env) ? 'FAIL' : 'warn';
    error(`${tag} ${where}: base ref ${ref} is not available, cannot check that the list only shrinks.`);
    if (where === 'FAIL') return 1;
  } else if (base.kind === 'no-list') {
    log(`${tag} ${ref} has no allowlist yet: this change introduces it, nothing to compare.`);
  }
  const problems = compareCounts(listed, actual, base.kind === 'list' ? base.counts : null, ref, list);
  problems.forEach((p) => error(`${tag} ${p}`));
  if (problems.length > 0) return 1;
  const total = Object.values(listed).reduce((a, b) => a + b, 0);
  log(`${tag} ok: ${Object.keys(listed).length} files (${total} reports) still to migrate, none new, none stale`);
  return 0;
}
