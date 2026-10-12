/**
 * The column census without a database (breaker r2 N9): the integration census (audit-snapshots-columns) checks the
 * live schema, but GitHub's CI runs no integration tests, so a PR adding a ledger column would merge green. This reads
 * the migrations instead: every column a migration ADDs (or RENAMEs to) on gl_journal_entries / gl_journal_lines, and
 * has not dropped since, must be frozen in the snapshot's rows (snapshotRows.ts) or named as not material
 * (tests/helpers/auditSnapshotColumns.ts). Columns from the tables' original CREATE are the integration census's.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NOT_MATERIAL, RENAMED } from '../../../helpers/auditSnapshotColumns';

const ROOT = path.resolve(__dirname, '../../../..');
const MIGRATIONS = path.join(ROOT, 'scripts/migrations/sql');
type Table = 'gl_journal_entries' | 'gl_journal_lines';
const NOT_A_COLUMN = new Set(['constraint', 'primary', 'foreign', 'unique', 'check', 'exclude', 'default', 'not', 'identity', 'expression']);

const stripComments = (sql: string) => sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');

/** Where the statement starting at `from` ends: the first ';' outside a '…' string literal. */
function statementEnd(sql: string, from: number): number {
  let quoted = false;
  for (let i = from; i < sql.length; i++) {
    if (sql[i] === "'") quoted = !quoted; // '' inside a literal toggles twice: still inside
    else if (sql[i] === ';' && !quoted) return i;
  }
  return sql.length;
}

const TABLE = /\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(?:"?public"?\s*\.\s*)?"?(gl_journal_entries|gl_journal_lines)"?(?![\w"])/gi;
const IDENT = '"?([a-z_][a-z0-9_]*)"?';

/** The columns migrations add to the two tables (in file order: added, renamed to, dropped). */
function addedColumns(files: string[]): Record<Table, Set<string>> {
  const out: Record<Table, Set<string>> = { gl_journal_entries: new Set(), gl_journal_lines: new Set() };
  for (const raw of files) {
    const sql = stripComments(raw);
    for (const m of sql.matchAll(TABLE)) {
      const cols = out[m[1]!.toLowerCase() as Table];
      const body = sql.slice(m.index! + m[0].length, statementEnd(sql, m.index! + m[0].length));
      for (const [, name] of body.matchAll(new RegExp(`\\bADD\\s+(?:COLUMN\\s+)?(?:IF\\s+NOT\\s+EXISTS\\s+)?${IDENT}`, 'gi'))) {
        if (!NOT_A_COLUMN.has(name!.toLowerCase())) cols.add(name!.toLowerCase());
      }
      for (const [, from, to] of body.matchAll(new RegExp(`\\bRENAME\\s+(?:COLUMN\\s+)?${IDENT}\\s+TO\\s+${IDENT}`, 'gi'))) {
        cols.delete(from!.toLowerCase());
        cols.add(to!.toLowerCase());
      }
      for (const [, name] of body.matchAll(new RegExp(`\\bDROP\\s+(?:COLUMN\\s+)?(?:IF\\s+EXISTS\\s+)?${IDENT}`, 'gi'))) {
        if (!NOT_A_COLUMN.has(name!.toLowerCase())) cols.delete(name!.toLowerCase());
      }
    }
  }
  return out;
}

/** Dynamic SQL naming either table (EXECUTE / format with the name in a literal): the census cannot read it. */
function dynamicAlters(files: { name: string; sql: string }[]): string[] {
  return files.filter(({ sql }) => /\bEXECUTE\b[\s\S]{0,600}?'[^']*\b(gl_journal_entries|gl_journal_lines)\b[^']*'/i.test(stripComments(sql))
    && /\bALTER\s+TABLE\b/i.test(sql)).map(({ name }) => name);
}

/** The columns a snapshot's canonical row freezes: what `je.` / `jl.` the row's jsonb_build_object reads. */
function frozenColumns(): Record<Table, Set<string>> {
  const src = readFileSync(path.join(ROOT, 'src/modules/accounting/services/audit/snapshotRows.ts'), 'utf8');
  const rowOf = (fn: string, alias: string) => {
    const from = src.indexOf(`export async function ${fn}(`);
    const block = src.slice(src.indexOf('jsonb_build_object(', from), src.indexOf(') AS row', from));
    return new Set([...block.matchAll(new RegExp(`\\b${alias}\\.([a-z_][a-z0-9_]*)`, 'g'))].map((m) => m[1]!));
  };
  return { gl_journal_entries: rowOf('journalRows', 'je'), gl_journal_lines: rowOf('lineRows', 'jl') };
}

const migrationFiles = () => readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()
  .map((name) => ({ name, sql: readFileSync(path.join(MIGRATIONS, name), 'utf8') }));
const migrations = () => migrationFiles().map((f) => f.sql);

describe('frozen columns, read from the migrations', () => {
  it('reads ADD / RENAME / DROP COLUMN in any spelling the migrations use', () => {
    const got = addedColumns([
      'ALTER TABLE gl_journal_lines ADD COLUMN IF NOT EXISTS brk_new_amount NUMERIC(15,2);',
      'alter table public.gl_journal_entries\n  add column a text,\n  ADD b uuid, ADD CONSTRAINT x CHECK (true);',
      "-- ALTER TABLE gl_journal_entries ADD COLUMN commented_out TEXT;\nALTER TABLE ONLY gl_journal_entries ALTER COLUMN a DROP DEFAULT;",
      'ALTER TABLE gl_journal_entries RENAME COLUMN b TO c; ALTER TABLE IF EXISTS gl_journal_entries DROP COLUMN IF EXISTS a;',
      "DO $$ BEGIN EXECUTE 'ALTER TABLE gl_journal_lines ADD COLUMN dyn TEXT'; END $$;",
      // Breaker r3 C1's spellings: quoted names, public."…", and a ';' inside a literal before the ADD.
      'ALTER TABLE "gl_journal_lines" ADD COLUMN q1 NUMERIC;',
      'ALTER TABLE public."gl_journal_entries" ADD COLUMN q2 NUMERIC;',
      "ALTER TABLE gl_journal_lines ALTER COLUMN description SET DEFAULT 'n/a;', ADD COLUMN q3 NUMERIC;",
    ]);
    expect([...got.gl_journal_lines].sort()).toEqual(['brk_new_amount', 'dyn', 'q1', 'q3']);
    expect([...got.gl_journal_entries].sort()).toEqual(['c', 'q2']);
    expect(dynamicAlters([{ name: 'x.sql', sql: "DO $$ BEGIN EXECUTE format('ALTER TABLE %I ADD COLUMN z NUMERIC', 'gl_journal_lines'); END $$;" }]))
      .toEqual(['x.sql']);
  });

  it('no migration alters the two tables through dynamic SQL the census cannot read', () => {
    expect(dynamicAlters(migrationFiles())).toEqual([]);
  });

  it('every column a migration adds to gl_journal_entries / gl_journal_lines is frozen or named as not material', () => {
    const added = addedColumns(migrations());
    const frozen = frozenColumns();
    expect(frozen.gl_journal_entries.size).toBeGreaterThan(20);
    expect(frozen.gl_journal_lines.size).toBeGreaterThan(8);
    for (const table of ['gl_journal_entries', 'gl_journal_lines'] as const) {
      const unaccounted = [...added[table]].filter((col) =>
        !frozen[table].has(col) && !frozen[table].has(RENAMED[col] ?? col) && !(col in NOT_MATERIAL[table])).sort();
      expect(unaccounted, `${table}: added by a migration, neither frozen nor listed as not material`).toEqual([]);
    }
  });
});
