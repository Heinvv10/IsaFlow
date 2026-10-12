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

/** The columns migrations add to the two tables (in file order: added, renamed to, dropped). */
function addedColumns(files: string[]): Record<Table, Set<string>> {
  const out: Record<Table, Set<string>> = { gl_journal_entries: new Set(), gl_journal_lines: new Set() };
  const stmt = /\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(?:public\.)?(gl_journal_entries|gl_journal_lines)\b([^;]*)/gi;
  for (const sql of files) {
    for (const [, table, body] of stripComments(sql).matchAll(stmt)) {
      const cols = out[table!.toLowerCase() as Table];
      for (const [, name] of body!.matchAll(/\bADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?"?([a-z_][a-z0-9_]*)"?/gi)) {
        if (!NOT_A_COLUMN.has(name!.toLowerCase())) cols.add(name!.toLowerCase());
      }
      for (const [, from, to] of body!.matchAll(/\bRENAME\s+(?:COLUMN\s+)?"?([a-z_][a-z0-9_]*)"?\s+TO\s+"?([a-z_][a-z0-9_]*)"?/gi)) {
        cols.delete(from!.toLowerCase());
        cols.add(to!.toLowerCase());
      }
      for (const [, name] of body!.matchAll(/\bDROP\s+(?:COLUMN\s+)?(?:IF\s+EXISTS\s+)?"?([a-z_][a-z0-9_]*)"?/gi)) {
        if (!NOT_A_COLUMN.has(name!.toLowerCase())) cols.delete(name!.toLowerCase());
      }
    }
  }
  return out;
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

const migrations = () => readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()
  .map((f) => readFileSync(path.join(MIGRATIONS, f), 'utf8'));

describe('frozen columns, read from the migrations', () => {
  it('reads ADD / RENAME / DROP COLUMN in any spelling the migrations use', () => {
    const got = addedColumns([
      'ALTER TABLE gl_journal_lines ADD COLUMN IF NOT EXISTS brk_new_amount NUMERIC(15,2);',
      'alter table public.gl_journal_entries\n  add column a text,\n  ADD b uuid, ADD CONSTRAINT x CHECK (true);',
      "-- ALTER TABLE gl_journal_entries ADD COLUMN commented_out TEXT;\nALTER TABLE ONLY gl_journal_entries ALTER COLUMN a DROP DEFAULT;",
      'ALTER TABLE gl_journal_entries RENAME COLUMN b TO c; ALTER TABLE IF EXISTS gl_journal_entries DROP COLUMN IF EXISTS a;',
      "DO $$ BEGIN EXECUTE 'ALTER TABLE gl_journal_lines ADD COLUMN dyn TEXT'; END $$;",
    ]);
    expect([...got.gl_journal_lines].sort()).toEqual(['brk_new_amount', 'dyn']);
    expect([...got.gl_journal_entries].sort()).toEqual(['c']);
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
