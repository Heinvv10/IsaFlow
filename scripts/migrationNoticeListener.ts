/**
 * Notice plumbing for the migration runner.
 *
 * Migrations report per-tenant refusals and reconstructed row counts with
 * RAISE WARNING / RAISE NOTICE. node-postgres DISCARDS both unless a `notice`
 * listener is registered, so without one the operator running a deploy sees
 * nothing at all — only RAISE EXCEPTION surfaces, because errors travel as
 * errors. Printing them is the whole reason a migration is allowed to refuse a
 * row instead of guessing at it.
 */

/**
 * Postgres raises a NOTICE for every `IF NOT EXISTS` that skips, and the
 * corpus carries thousands of them — enough to bury a WARNING. These are those
 * codes, and only those: an unrecognised NOTICE always prints.
 *
 * Review round-5 L1. The previous filter dropped EVERY notice carrying a
 * non-zero SQLSTATE, which also swallowed `identifier "…" will be truncated`
 * (42622 — the object was created under a different name than written) and any
 * migration's own `RAISE NOTICE … USING ERRCODE`. It also documented 42704 as
 * filtered, which was never true: `DROP … IF EXISTS` notices carry 00000.
 */
export const SKIPPED_NOTICE_CODES = new Set([
  '42P07', // relation already exists, skipping
  '42710', // object (constraint, policy, trigger, type) already exists, skipping
  '42701', // column already exists, skipping
]);

export interface PgNotice {
  severity?: string;
  code?: string;
  message?: string;
}

/** Prints every notice the runner should not swallow, one line per line. */
export function makeNoticeListener(
  print: (line: string) => void = (line) => console.log(line),
): (n: PgNotice) => void {
  return (n: PgNotice) => {
    const severity = n.severity ?? 'NOTICE';
    if (severity === 'NOTICE' && SKIPPED_NOTICE_CODES.has(n.code ?? '00000')) return;
    for (const line of String(n.message ?? '').split('\n')) {
      print(`  [${severity}] ${line}`);
    }
  };
}
