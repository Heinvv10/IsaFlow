/**
 * R-035 N1b (A, migration 880): audit_log is append-only.
 *
 * After 880 no role but the table's owner may UPDATE, DELETE, TRUNCATE or
 * lock (`FOR UPDATE` / `FOR SHARE` need UPDATE) audit_log, so any app path
 * that did would 500 at runtime with 42501. This census finds one before it
 * ships: it enumerates BY TABLE — every statement that names the table and
 * erases, rewrites or locks it — over the source tree on DISK (not
 * `git ls-files`, which would pass an untracked new writer). INSERT is
 * untouched by 880 and is not counted.
 *
 * Migrations run as the owner and may still write the table; a LATER
 * migration that hands an erase privilege back, grants app_user or
 * platform_admin a role, moves the table's owner, or itself rewrites or
 * deletes audit rows undoes 880's point, so those are refused too (a real
 * data repair, as 293 once was, has to change this census on purpose).
 *
 * It is a TEXT check with the limits of approvalRequestWriteCensus: a grant
 * or statement built at run time slips past it. The live catalogue is read by
 * tests/integration/r035-n1b-audit-catalog against DATABASE_URL.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../../../..');
const ROOTS = ['src', 'pages', 'scripts', 'lib'];
const SOURCE = /\.(ts|tsx|js|mjs|cjs|sql)$/;
const MIGRATIONS = 'scripts/migrations/sql/';
const APPEND_ONLY_FROM = 880;

function walk(dir: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (SOURCE.test(entry.name)) out.push(full);
  }
}

function sourceFiles(): { file: string; text: string }[] {
  const files: string[] = [];
  for (const root of ROOTS) walk(path.join(ROOT, root), files);
  return files.map((f) => ({ file: path.relative(ROOT, f), text: readFileSync(f, 'utf8') }));
}

/** Comments out: a comment naming the table is not a statement. */
const stripComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`\w])\/\/[^\n]*/g, '$1').replace(/--[^\n]*/g, ' ');

const TABLE = String.raw`(?:only\s+)?(?:"?public"?\s*\.\s*)?"?audit_log"?\b`;
const ERASE = new RegExp(String.raw`\b(?:update|delete\s+from|truncate(?:\s+table)?|merge\s+into)\s+${TABLE}`, 'i');
const LOCK = /\bfor\s+(?:no\s+key\s+update|key\s+share|update|share)\b/i;
/** A quoted table name is how a dynamic `DELETE FROM ${table}` would reach it. */
const QUOTED = /['"`]audit_log['"`]/;

/** Every reason `text` breaks the census (empty: none). */
export function violations(text: string): string[] {
  const code = stripComments(text);
  const out: string[] = [];
  if (ERASE.test(code)) out.push('updates, deletes or truncates audit_log');
  if (QUOTED.test(code)) out.push('names audit_log as a string');
  // A statement is a template literal or a quoted string: a lock clause in one
  // that names the table locks it.
  for (const chunk of code.split(/`/)) {
    if (/\baudit_log\b/i.test(chunk) && LOCK.test(chunk)) out.push('locks audit_log');
  }
  return out;
}

/**
 * The string mentions on master, each read and found not to be a statement:
 * the export route's own audit entity type, and the CI lint's list of tables
 * whose user id is text. A new one is a new reason to look.
 */
const KNOWN_STRINGS = [
  'pages/api/accounting/audit-log-export.ts: names audit_log as a string',
  'scripts/ci/userIdCastRules.ts: names audit_log as a string',
];

const REGRANT = [
  /\bgrant\b[^;]*\b(?:update|delete|truncate|trigger|all)\b[^;]*\bon\s+(?:table\s+)?(?:[\w".\s]+,\s*)*(?:public\.)?"?audit_log\b/i,
  /\bgrant\b[^;]*\bon\s+all\s+tables\s+in\s+schema\s+public\b/i,
  // A ROLE grant (no ON clause) to a runtime role: membership in the owner,
  // pg_write_all_data or any role holding the erase hands it back.
  /\bgrant\s+(?![^;]*\bon\b)[^;]*\bto\s+[^;]*\b(?:app_user|platform_admin)\b/i,
  // A new owner of the table changes who may erase it.
  /\balter\s+table\s+(?:only\s+)?(?:if\s+exists\s+)?(?:public\.)?"?audit_log"?\s+owner\b/i,
];
const migrationNumber = (file: string): number => Number(/(\d{3})[a-z]?_/.exec(path.basename(file))?.[1] ?? '999');
const laterMigrations = () => sourceFiles()
  .filter(({ file }) => file.startsWith(MIGRATIONS) && migrationNumber(file) > APPEND_ONLY_FROM);

describe('audit_log is append-only (census by table)', () => {
  it('no source file updates, deletes, truncates, locks or (beyond the known two) names the table', () => {
    const found = sourceFiles()
      .filter(({ file }) => !file.startsWith(MIGRATIONS))
      .flatMap(({ file, text }) => violations(text).map((why) => `${file}: ${why}`));
    expect(found).toEqual(KNOWN_STRINGS);
  });

  it('the append-only migration exists (this census is anchored to it)', () => {
    const own = sourceFiles().filter(({ file }) => file.startsWith(MIGRATIONS) && migrationNumber(file) === APPEND_ONLY_FROM);
    expect(own.map(({ file }) => path.basename(file))).toEqual(['880_audit_log_append_only.sql']);
  });

  it('no migration after 880 hands an erase privilege back, grants a runtime role a role, or moves the owner', () => {
    const found = laterMigrations()
      .filter(({ text }) => REGRANT.some((re) => re.test(stripComments(text))))
      .map(({ file }) => file);
    expect(found).toEqual([]);
  });

  it('no migration after 880 rewrites or deletes audit rows', () => {
    const found = laterMigrations().filter(({ text }) => ERASE.test(stripComments(text))).map(({ file }) => file);
    expect(found).toEqual([]);
  });
});

describe('the census detects (counterexamples)', () => {
  it.each([
    ['an UPDATE', 'await sql`UPDATE audit_log SET user_id = ${u} WHERE id = ${id}`'],
    ['a schema-qualified DELETE', "client.query('DELETE FROM public.audit_log WHERE id = $1')"],
    ['a quoted DELETE', 'sql`DELETE FROM "audit_log" WHERE id = 1`'],
    ['a TRUNCATE', "pool.query('TRUNCATE TABLE audit_log')"],
    ['a MERGE', 'sql`MERGE INTO audit_log a USING x ON true WHEN MATCHED THEN DELETE`'],
    ['a row lock', 'sql`SELECT id FROM audit_log a WHERE a.id = ${id} FOR UPDATE`'],
    ['a FOR SHARE in a join', 'sql`SELECT 1 FROM companies c JOIN audit_log a ON true FOR SHARE`'],
    ['a dynamic table name', "for (const t of ['bills', 'audit_log']) await sql.unsafe(`DELETE FROM ${t}`)"],
  ])('%s', (_label, text) => {
    expect(violations(text)).not.toEqual([]);
  });

  it.each([
    ['a read', 'sql`SELECT * FROM audit_log WHERE company_id = ${c}`'],
    ['the INSERT', 'sql`INSERT INTO audit_log (company_id, user_id) VALUES (${c}, ${u})`'],
    ['a comment', '// DELETE FROM audit_log — refused since migration 880'],
    ['a lock on another table', 'sql`SELECT id FROM supplier_invoices WHERE id = ${id} FOR UPDATE`'],
    ['a different table', 'sql`DELETE FROM admin_audit_log WHERE id = ${id}`'],
  ])('and passes %s', (_label, text) => {
    expect(violations(text)).toEqual([]);
  });

  it.each([
    'GRANT UPDATE ON audit_log TO app_user;',
    'GRANT DELETE ON TABLE public.audit_log TO platform_admin;',
    'GRANT ALL ON public.approval_rules, public.audit_log TO app_user;',
    'GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA public TO app_user;',
    'GRANT migration_admin TO app_user;',
    'GRANT pg_write_all_data TO platform_admin;',
    'ALTER TABLE public.audit_log OWNER TO app_user;',
  ])('a re-grant or ownership change in a later migration: %s', (stmt) => {
    expect(REGRANT.some((re) => re.test(stmt))).toBe(true);
  });

  it.each([
    'GRANT INSERT, SELECT ON audit_log TO app_user;',
    'GRANT SELECT ON admin_audit_log TO platform_admin;',
    'GRANT USAGE ON SCHEMA app TO app_user;',
  ])('and passes %s', (stmt) => {
    expect(REGRANT.some((re) => re.test(stmt))).toBe(false);
  });
});
