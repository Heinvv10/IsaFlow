/**
 * R-035 N1 (migration 872): approval_requests is written only through its
 * SECURITY DEFINER functions, and only gl/approvalRequestWrites.ts calls them.
 *
 * After 872 no role but the table's owner may INSERT, UPDATE, DELETE,
 * TRUNCATE or lock (`FOR UPDATE` / `FOR SHARE` need UPDATE) the table, so any
 * other writer 500s at runtime with 42501. This census finds one before it
 * ships: it enumerates BY TABLE — every statement that names the table and
 * writes or locks it — over the source tree on DISK (not `git ls-files`, which
 * would pass an untracked new writer), and pins the callers of the functions.
 * Migrations are the owner's and may write it; a later migration that hands a
 * write grant back would undo 872, so those are scanned for re-grants.
 *
 * It is a TEXT check, and its limits are known (adversarial round 2): a grant
 * built at run time (`EXECUTE 'GRANT UPD' || 'ATE …'`, `format('GRANT %s ON %I
 * …')` — the shape 872 itself uses), a later CREATE OR REPLACE of a writer
 * with a weaker body, and `ALTER FUNCTION … SECURITY INVOKER` all slip past
 * it. tests/integration/r035-n1-catalog reads the live catalogue for those
 * (prosecdef, search_path, owner, EXECUTE, every role's privileges, the
 * writers' pinned bodies, statically named writes) against whatever
 * DATABASE_URL names (local `bun run ci` with a database; GitHub runs none).
 * A NEW writer built from run-time SQL is beyond both (migration review is
 * the control); the four existing writers are pinned by body and covered by
 * the fixture behaviour suites.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../../../..');
const ROOTS = ['src', 'pages', 'scripts', 'lib'];
const SOURCE = /\.(ts|tsx|js|mjs|cjs|sql)$/;
const MIGRATIONS = 'scripts/migrations/sql/';
const WRITERS_FILE = 'src/modules/accounting/services/gl/approvalRequestWrites.ts';

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

/** Comments out: a comment naming the table or a function is not a statement. */
const stripComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`\w])\/\/[^\n]*/g, '$1').replace(/--[^\n]*/g, ' ');

const TABLE = String.raw`(?:only\s+)?(?:"?public"?\s*\.\s*)?"?approval_requests"?\b`;
const WRITE = new RegExp(String.raw`\b(?:insert\s+into|update|delete\s+from|truncate(?:\s+table)?|merge\s+into|copy)\s+${TABLE}`, 'i');
const LOCK = /\bfor\s+(?:no\s+key\s+update|key\s+share|update|share)\b/i;
const CALL = /\bapproval_request_(?:raise|rebind|decide|lock)\s*\(/i;
/** A quoted table name is how a dynamic `DELETE FROM ${table}` would reach it. */
const QUOTED = /['"`]approval_requests['"`]/;

/** Every reason `text` breaks the census (empty: none). */
export function violations(text: string): string[] {
  const code = stripComments(text);
  const out: string[] = [];
  if (WRITE.test(code)) out.push('writes approval_requests');
  if (QUOTED.test(code)) out.push('names approval_requests as a string');
  // A statement is a template literal or a quoted string: a lock clause in one
  // that names the table locks it.
  for (const chunk of code.split(/`/)) {
    if (/\bapproval_requests\b/i.test(chunk) && LOCK.test(chunk)) out.push('locks approval_requests');
  }
  if (CALL.test(code)) out.push('calls an approval_request_* writer');
  return out;
}

const REGRANT = [
  /\bgrant\b[^;]*\b(?:insert|update|delete|truncate|trigger|all)\b[^;]*\bon\s+(?:table\s+)?(?:[\w".\s]+,\s*)*(?:public\.)?approval_requests\b/i,
  /\bgrant\b[^;]*\bon\s+all\s+tables\s+in\s+schema\s+public\b/i,
  // A ROLE grant (no ON clause) to app_user: membership in postgres,
  // pg_write_all_data or any writer hands the table's writes back.
  /\bgrant\s+(?![^;]*\bon\b)[^;]*\bto\s+[^;]*\bapp_user\b/i,
  // A new owner of the table or of a writer changes who writes it.
  /\balter\s+table\s+(?:only\s+)?(?:if\s+exists\s+)?(?:public\.)?"?approval_requests"?\s+owner\b/i,
  /\balter\s+function\s+(?:public\.)?approval_request_\w+\s*\([^)]*\)\s+owner\b/i,
];
const migrationNumber = (file: string): number => Number(/(\d{3})[a-z]?_/.exec(path.basename(file))?.[1] ?? '999');

describe('approval_requests writers (census by table)', () => {
  it('no source file but approvalRequestWrites.ts writes, locks or names the table, or calls its writers', () => {
    const found = sourceFiles()
      .filter(({ file }) => !file.startsWith(MIGRATIONS))
      .flatMap(({ file, text }) => violations(text).map((why) => `${file}: ${why}`));
    expect(found).toEqual([`${WRITERS_FILE}: calls an approval_request_* writer`]);
  });

  it('the writers file calls each of the four functions', () => {
    const text = stripComments(readFileSync(path.join(ROOT, WRITERS_FILE), 'utf8'));
    for (const fn of ['raise', 'rebind', 'decide', 'lock']) {
      expect(text, fn).toMatch(new RegExp(String.raw`\bapproval_request_${fn}\(`));
    }
  });

  it('no migration after 872 hands a write privilege on the table back, grants app_user a role, or moves an owner', () => {
    const found = sourceFiles()
      .filter(({ file }) => file.startsWith(MIGRATIONS) && migrationNumber(file) > 872)
      .filter(({ text }) => REGRANT.some((re) => re.test(stripComments(text))))
      .map(({ file }) => file);
    expect(found).toEqual([]);
  });
});

describe('the census detects (counterexamples)', () => {
  it.each([
    ['an UPDATE', 'await sql`UPDATE approval_requests SET status = ${s}`'],
    ['a schema-qualified INSERT', "client.query('INSERT INTO public.approval_requests (id) VALUES ($1)')"],
    ['a quoted DELETE', 'sql`DELETE FROM "approval_requests" WHERE id = 1`'],
    ['a TRUNCATE', "pool.query('TRUNCATE TABLE approval_requests')"],
    ['a row lock', 'sql`SELECT id FROM approval_requests ar WHERE ar.id = ${id} FOR UPDATE`'],
    ['a FOR SHARE in a join', 'sql`SELECT 1 FROM supplier_invoices si JOIN approval_requests ar ON true FOR SHARE`'],
    ['a dynamic table name', "for (const t of ['bills', 'approval_requests']) await sql.unsafe(`DELETE FROM ${t}`)"],
    ['a direct call of a writer', 'sql`SELECT * FROM approval_request_decide(${a}, ${b})`'],
  ])('%s', (_label, text) => {
    expect(violations(text)).not.toEqual([]);
  });

  it.each([
    ['a read', 'sql`SELECT * FROM approval_requests WHERE company_id = ${c}`'],
    ['a comment', '// UPDATE approval_requests SET status — now approval_request_decide (migration 872)'],
    ['a lock on another table', 'sql`SELECT id FROM supplier_invoices WHERE id = ${id} FOR UPDATE`'],
  ])('and passes %s', (_label, text) => {
    expect(violations(text)).toEqual([]);
  });

  it('a re-grant in a later migration', () => {
    expect(REGRANT.some((re) => re.test('GRANT UPDATE ON approval_requests TO app_user;'))).toBe(true);
    expect(REGRANT.some((re) => re.test('GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA public TO app_user;'))).toBe(true);
    expect(REGRANT.some((re) => re.test('GRANT SELECT ON approval_requests TO app_user;'))).toBe(false);
    expect(REGRANT.some((re) => re.test('GRANT USAGE ON SCHEMA app TO app_user;'))).toBe(false);
  });

  it.each([
    'GRANT postgres TO app_user;',
    'GRANT pg_write_all_data TO app_user;',
    'GRANT migration_admin, platform_admin TO app_user WITH INHERIT TRUE;',
    'ALTER TABLE approval_requests OWNER TO migration_admin;',
    'ALTER TABLE IF EXISTS public.approval_requests OWNER TO app_user;',
    'ALTER FUNCTION public.approval_request_decide(uuid, uuid, text, text, text, text) OWNER TO migration_admin;',
  ])('a role membership or ownership change in a later migration: %s', (stmt) => {
    expect(REGRANT.some((re) => re.test(stmt))).toBe(true);
  });
});
