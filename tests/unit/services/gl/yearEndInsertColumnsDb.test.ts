/**
 * The year-end closing journal INSERT must name columns that EXIST.
 *
 * `closeFiscalYear` inserted `total_debit` and `total_credit` into
 * `gl_journal_entries`. Neither column exists — not in `isaflow_dev`, not in
 * production, and not in `200_accounting_foundation.sql`'s current shape. Every
 * live year-end close therefore threw 42703 (`column "total_debit" of relation
 * "gl_journal_entries" does not exist`) before writing a single line, through
 * the UI route as well as over MCP. Brightsphere's four unclosed year-ends and
 * its R8.46m of retained earnings with no journal behind it are not an
 * oversight by whoever runs the close: the operation has never been able to
 * complete.
 *
 * The existing unit tests could not catch it. They mock the `tx` tagged
 * template, so they assert the shape of the statement and never that Postgres
 * will accept it — the failure lives exactly in the gap between a mocked
 * template and a real one.
 *
 * So this test asks the DATABASE. It is deliberately schema-introspecting
 * rather than a full posting test: reproducing a balanced journal needs fiscal
 * periods, accounts and a company, and none of that is what broke. Every column
 * the service names has to exist, and the test reads the column list out of the
 * service's own source so it cannot drift from what actually ships.
 *
 * DB-gated: skipped without DATABASE_URL, which is why `bun run ci` alone would
 * not have caught this either.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDbReachable } from '../../helpers/dbReachable';
import { getPoolForTests } from '@/lib/neon';

const SERVICE = join(
  process.cwd(),
  'src/modules/accounting/services/gl/yearEndCloseService.ts',
);

/**
 * Pulls the column list out of an `INSERT INTO <table> ( ... ) VALUES` in the
 * service source. Reading the source keeps the test honest: an assertion
 * against a hand-copied list passes forever after someone edits the query.
 */
function insertedColumns(source: string, table: string): string[] {
  const match = new RegExp(`INSERT INTO ${table}\\s*\\(([^)]*)\\)`, 'i').exec(source);
  if (!match) throw new Error(`no INSERT INTO ${table} found in ${SERVICE}`);
  return match[1]!
    .split(',')
    .map((c) => c.replace(/--.*$/gm, '').trim())
    .filter((c) => c.length > 0);
}

async function columnsOf(table: string): Promise<Set<string>> {
  const pool = getPoolForTests();
  const { rows } = await pool.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1`,
    [table],
  );
  return new Set(rows.map((r) => r.column_name));
}

describe('year-end closing journal — every inserted column exists', () => {
  it('names only real gl_journal_entries columns', async () => {
    if (!(await isDbReachable())) return;

    const source = readFileSync(SERVICE, 'utf8');
    const named = insertedColumns(source, 'gl_journal_entries');
    const real = await columnsOf('gl_journal_entries');

    expect(named.length).toBeGreaterThan(5);
    const missing = named.filter((c) => !real.has(c));
    expect(missing, `gl_journal_entries has no column(s): ${missing.join(', ')}`).toEqual([]);
  });

  it('names only real gl_journal_lines columns', async () => {
    if (!(await isDbReachable())) return;

    const source = readFileSync(SERVICE, 'utf8');
    const named = insertedColumns(source, 'gl_journal_lines');
    const real = await columnsOf('gl_journal_lines');

    const missing = named.filter((c) => !real.has(c));
    expect(missing, `gl_journal_lines has no column(s): ${missing.join(', ')}`).toEqual([]);
  });

  it('does NOT carry entry totals on the header — they are derived from the lines', async () => {
    // Pinning the specific regression: the totals belong to the lines, and the
    // header columns that used to hold them are gone.
    const source = readFileSync(SERVICE, 'utf8');
    const named = insertedColumns(source, 'gl_journal_entries');
    expect(named).not.toContain('total_debit');
    expect(named).not.toContain('total_credit');
  });
});
