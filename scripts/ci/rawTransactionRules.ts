/**
 * Raw transaction control through the `sql` helper is forbidden. This module is
 * the RULE; `check-raw-transaction-control.ts` only walks the tree and reports.
 * Kept separate so the rule itself is unit-tested — see
 * `tests/unit/ci/rawTransactionRules.test.ts`.
 *
 * ── WHY ─────────────────────────────────────────────────────────────────────
 *
 * `sql` routes onto the AsyncLocalStorage request client when one is in flight
 * (`src/lib/neon.ts`, `LazyQuery.run`), and `withAuth` opens a transaction for
 * EVERY request. So `await sql`COMMIT`` does not commit the block a service
 * wrapped — it commits the WHOLE REQUEST. Every earlier write becomes durable
 * and any enclosing savepoint ceases to exist.
 *
 * `calculatePayrollRun` did exactly this. On the MCP path it destroyed the
 * registry's per-tool savepoint, and the `RELEASE SAVEPOINT` that followed then
 * errored into a GENERIC_FAILURE over payroll run lines that had ALREADY
 * committed. Five services carried the pattern; all five are fixed (2026-09-05).
 *
 * The remedy is `withTransaction` from `@/lib/neon`, which nests a SAVEPOINT
 * when a request transaction is in flight and opens a real transaction only
 * when there is none.
 *
 * ── WHY THIS IS NOT A GREP ──────────────────────────────────────────────────
 *
 * The first cut was one, and a blind review took it apart. It was line-anchored,
 * so `` await sql`\n  BEGIN\n` `` — the MULTI-LINE form every converted block in
 * this codebase is written in — sailed past. It also missed `sql.query(...)` and
 * `sql.unsafe(...)`, which `createSql` defines as the same function and which
 * route identically. A gate that only catches the spelling the last offender
 * happened to use is theatre.
 */

export interface RawTxViolation {
  line: number;
  text: string;
  form: 'template' | 'call';
}

/** The three statements that must never be issued through the `sql` helper. */
const KEYWORDS = ['BEGIN', 'COMMIT', 'ROLLBACK', 'START TRANSACTION', 'SAVEPOINT', 'RELEASE'];

/**
 * The identifiers that ROUTE onto a connection the caller does not own.
 *
 * `client` is deliberately ABSENT. `client.query('BEGIN')` on a pool client you
 * explicitly connected is the CORRECT pattern and is how `withTransaction`,
 * `withAuth` and `bearerPipeline` open their real transactions — flagging it
 * would condemn the remedy along with the defect. The first draft of this rule
 * did exactly that and reported 35 correct call sites as violations.
 *
 * `tx` IS included: a `tx` bound by `withTransaction` on the savepoint branch
 * writes to the shared ALS client, so `tx`COMMIT`` there commits the request
 * just as `sql`COMMIT`` would.
 */
const HELPERS = ['sql', 'tx'];

/**
 * Blank out comments so a commented-out offender is not reported, and a
 * commented-out one cannot be used to smuggle a real one past a naive scan.
 * Replaces with spaces rather than deleting, so line numbers survive.
 */
export function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
}

/** Is this template/argument body ONLY a transaction-control statement? */
function isBareTransactionControl(body: string): boolean {
  const normalised = body.trim().replace(/;$/, '').trim().toUpperCase();
  if (normalised.length === 0) return false;
  // `SAVEPOINT x` / `RELEASE SAVEPOINT x` carry a name, so match the head.
  return KEYWORDS.some((k) => normalised === k || normalised.startsWith(`${k} `));
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

/**
 * Every raw transaction-control statement issued through the `sql` helper.
 *
 * Matches the TAGGED TEMPLATE form across newlines, and the
 * `sql.query('COMMIT')` / `sql.unsafe('COMMIT')` call form. The template body
 * must be ONLY the keyword — a real query that happens to contain the word
 * (`WHERE begin_date > ...`) is not a violation and is not reported.
 */
export function findRawTransactionControl(source: string): RawTxViolation[] {
  const clean = stripComments(source);
  const out: RawTxViolation[] = [];
  const helpers = HELPERS.join('|');

  // Tagged template: sql`...`, across newlines. No `await` requirement — a
  // deferred `const x = sql`BEGIN`` is the same statement, just awaited later.
  const template = new RegExp(`\\b(?:${helpers})\\s*\`([^\`]*)\``, 'g');
  for (let m = template.exec(clean); m !== null; m = template.exec(clean)) {
    if (isBareTransactionControl(m[1] ?? '')) {
      out.push({ line: lineOf(clean, m.index), text: m[0].replace(/\s+/g, ' ').trim(), form: 'template' });
    }
  }

  // Call form: sql.query('COMMIT') / sql.unsafe('COMMIT') / client.query('BEGIN').
  const call = new RegExp(`\\b(?:${helpers})\\.(?:query|unsafe)\\s*\\(\\s*(['"\`])([^'"\`]*)\\1`, 'g');
  for (let m = call.exec(clean); m !== null; m = call.exec(clean)) {
    if (isBareTransactionControl(m[2] ?? '')) {
      out.push({ line: lineOf(clean, m.index), text: m[0].replace(/\s+/g, ' ').trim(), form: 'call' });
    }
  }

  return out.sort((a, b) => a.line - b.line);
}
