/**
 * R-035 N1b (A, migration 880): audit_log is append-only.
 *
 * After 880 no role but the table's owner may UPDATE, DELETE, TRUNCATE or
 * lock (`FOR UPDATE` / `FOR SHARE` need UPDATE) audit_log, nor INSERT … ON
 * CONFLICT DO UPDATE (needs UPDATE), so any app path that did would 500 at
 * runtime with 42501. This census finds one before it ships, BY TABLE, over
 * the source tree on disk (tests/unit/helpers/sourceCensus.ts: what is read,
 * and how comments are stripped without hiding a statement in a string).
 *
 * Migrations run as the owner and may still write the table, so they are
 * judged differently: EVERY migration file but 880 — whatever its number, so
 * an 877–879 merged after 880, or an `880b_`, is judged too (blind review M1,
 * M2) — is checked for anything that would hand the erase back or route
 * around it: a write grant on the table, `ALL TABLES IN SCHEMA public`, a role
 * grant to app_user or platform_admin, an owner move, an erase or rewrite of
 * rows, an ALTER, a trigger, a rule, a view, a drop or re-create of the table
 * (adversarial review REPRO 4 and 5). The ones that predate 880 are pinned by
 * name, each read; a new one fails until someone reads it and pins it.
 *
 * It is a TEXT check; tests/integration/r035-n1b-audit-catalog reads the live
 * catalogue (grants, views, function bodies) against DATABASE_URL.
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { filesUnder, migrationNumber, ROOT, sourceFiles, stripComments, type SourceFile } from '../../helpers/sourceCensus';

const MIGRATIONS = 'scripts/migrations/sql/';
const OWN = '880_audit_log_append_only.sql';
const TABLE = String.raw`(?:only\s+)?(?:"?public"?\s*\.\s*)?"?audit_log"?\b`;
const ERASE = [
  new RegExp(String.raw`\b(?:update|delete\s+from|merge\s+into)\s+${TABLE}`, 'i'),
  // TRUNCATE takes a list: `TRUNCATE companies, audit_log` (REPRO 3, E1).
  /\btruncate\b[^;]*?\baudit_log\b/i,
];
const LOCK = /\bfor\s+(?:no\s+key\s+update|key\s+share|update|share)\b/i;
const UPSERT = /\bon\s+conflict\b[^;]*?\bdo\s+update\b/i;
/** A quoted table name is how a dynamic `DELETE FROM ${table}` would reach it. */
const QUOTED = /['"`]audit_log['"`]/;

/** Every reason `text` breaks the census (empty: none). */
export function violations(text: string, file = 'x.ts'): string[] {
  const code = stripComments(text, file);
  const out: string[] = [];
  if (ERASE.some((re) => re.test(code))) out.push('updates, deletes or truncates audit_log');
  if (QUOTED.test(code)) out.push('names audit_log as a string');
  // A statement is a template literal or a quoted string: a lock clause or an
  // upsert's DO UPDATE in one that names the table needs UPDATE on it.
  for (const chunk of code.split(/`/)) {
    if (!/\baudit_log\b/i.test(chunk)) continue;
    if (LOCK.test(chunk)) out.push('locks audit_log');
    if (UPSERT.test(chunk) && /\binsert\s+into\s+(?:"?public"?\s*\.\s*)?"?audit_log\b/i.test(chunk)) out.push('upserts audit_log');
  }
  return [...new Set(out)];
}

const GRANTED = [
  /\bgrant\b[^;]*\b(?:update|delete|truncate|trigger|all)\b[^;]*\bon\s+(?:table\s+)?(?:[\w".\s]+,\s*)*(?:"?public"?\.)?"?audit_log\b/i,
  /\bgrant\b[^;]*\bon\s+all\s+tables\s+in\s+schema\s+"?public"?/i,
  // A ROLE grant (no ON clause) to a runtime role: membership in the owner,
  // pg_write_all_data or any role holding the erase hands it back.
  /\bgrant\s+(?![^;]*\bon\b)[^;]*\bto\s+[^;]*\b(?:app_user|platform_admin)\b/i,
];
const DDL = [
  /\balter\s+table\s+(?:only\s+)?(?:if\s+exists\s+)?(?:"?public"?\.)?"?audit_log"?\b/i,
  /\bcreate\s+(?:or\s+replace\s+)?(?:constraint\s+)?trigger\b[^;]*\bon\s+(?:"?public"?\.)?"?audit_log\b/i,
  /\bcreate\s+(?:or\s+replace\s+)?rule\b[^;]*\bto\s+(?:"?public"?\.)?"?audit_log\b/i,
  /\bcreate\s+(?:or\s+replace\s+)?(?:materialized\s+)?view\b[^;]*\baudit_log\b/i,
  /\b(?:drop|create)\s+table\b[^;]*?\baudit_log\b/i,
];

/** Why a migration (not 880) needs reading. */
export function migrationViolations(text: string): string[] {
  const code = stripComments(text, 'm.sql');
  const out: string[] = [];
  if (GRANTED.some((re) => re.test(code))) out.push('grants');
  if (ERASE.some((re) => re.test(code))) out.push('erases');
  if (DDL.some((re) => re.test(code))) out.push('ddl');
  return out;
}

/**
 * The string mentions in app code, each read and found not to be a
 * statement: the export route's own audit entity type, and the CI lint's list
 * of tables whose user id is text.
 */
const KNOWN_STRINGS = [
  'pages/api/accounting/audit-log-export.ts: names audit_log as a string',
  'scripts/ci/userIdCastRules.ts: names audit_log as a string',
];

/**
 * Migrations before 880 that match, each read: 267 creates the table; 293 is
 * the one-off user-id repair (ran as the owner, before 880 existed); 348 and
 * 352 are the blanket grants 880 exists to take back. Re-read this list when
 * it changes.
 */
const KNOWN_MIGRATIONS: Record<string, string[]> = {
  '267_audit_trail.sql': ['ddl'],
  '293_fix_admin_user_uuid.sql': ['erases'],
  '348_rls_and_auth_helpers.sql': ['grants'],
  '352_platform_admin_role.sql': ['grants'],
};

const all = (() => { let cache: SourceFile[] | undefined; return () => (cache ??= sourceFiles()); })();
const isMigration = (file: string) => file.startsWith(MIGRATIONS) && file.endsWith('.sql');

describe('audit_log is append-only (census by table)', () => {
  it('reads what it claims: every root, every extension, and the one INSERT site', () => {
    const files = all();
    expect(files.length).toBeGreaterThan(3000);
    const exts = new Set(files.map((f) => path.extname(f.file)));
    for (const ext of ['.ts', '.tsx', '.js', '.mjs', '.sql', '.sh']) expect(exts.has(ext), ext).toBe(true);
    for (const known of ['middleware.ts', 'src/modules/accounting/services/core/auditTrailService.ts', `${MIGRATIONS}${OWN}`]) {
      expect(files.some((f) => f.file === known), known).toBe(true);
    }
    // A directory it cannot read is an error, never an empty scan (only a missing one is skipped).
    expect(() => filesUnder(path.join(ROOT, 'package.json'))).toThrow(/ENOTDIR/);
    expect(filesUnder(path.join(ROOT, 'no-such-dir'))).toEqual([]);
    const insert = files.find((f) => f.file.endsWith('core/auditTrailService.ts'))!;
    expect(stripComments(insert.text, insert.file)).toMatch(/\binsert\s+into\s+audit_log\b/i);
  });

  it('no app source updates, deletes, truncates, upserts, locks or (beyond the known two) names the table', () => {
    const found = all()
      .filter(({ file }) => !isMigration(file))
      .flatMap(({ file, text }) => violations(text, file).map((why) => `${file}: ${why}`));
    expect(found).toEqual(KNOWN_STRINGS);
  });

  it('no migration but 880 and the pinned pre-880 ones grants, erases, alters, triggers, views, drops or re-creates it', () => {
    const found = Object.fromEntries(all()
      .filter(({ file }) => isMigration(file) && path.basename(file) !== OWN)
      .map(({ file, text }) => [path.basename(file), migrationViolations(text)] as const)
      .filter(([, why]) => why.length > 0));
    expect(found).toEqual(KNOWN_MIGRATIONS);
    for (const name of Object.keys(KNOWN_MIGRATIONS)) expect(migrationNumber(name), name).toBeLessThan(880);
  });
});

describe('the census detects (counterexamples)', () => {
  const ERASES = 'updates, deletes or truncates audit_log';
  it.each([
    ['an UPDATE', 'await sql`UPDATE audit_log SET user_id = ${u} WHERE id = ${id}`', ERASES],
    ['an UPDATE ONLY, quoted and schema-qualified', 'sql`UPDATE ONLY "public"."audit_log" SET action = ${a}`', ERASES],
    ['an UPDATE ONLY', 'sql`UPDATE ONLY audit_log SET action = ${a}`', ERASES],
    ['a schema-qualified DELETE', "client.query('DELETE FROM public.audit_log WHERE id = $1')", ERASES],
    ['a quoted-schema DELETE', 'sql`DELETE FROM "public".audit_log WHERE id = 1`', ERASES],
    ['a TRUNCATE', "pool.query('TRUNCATE TABLE audit_log')", ERASES],
    ['a TRUNCATE of a list (E1)', "pool.query('TRUNCATE companies, audit_log CASCADE')", ERASES],
    ['a MERGE', 'sql`MERGE INTO audit_log a USING x ON true WHEN MATCHED THEN DELETE`', ERASES],
    ['an upsert (E2)', 'sql`INSERT INTO audit_log (id) VALUES (${i}) ON CONFLICT (id) DO UPDATE SET action = ${a}`', 'upserts audit_log'],
    ['a row lock', 'sql`SELECT id FROM audit_log a WHERE a.id = ${id} FOR UPDATE`', 'locks audit_log'],
    ['a FOR KEY SHARE in a join', 'sql`SELECT 1 FROM companies c JOIN audit_log a ON true FOR KEY SHARE`', 'locks audit_log'],
    ['a dynamic table name', "for (const t of ['bills', 'audit_log']) await sql.unsafe(`DELETE FROM ${t}`)", 'names audit_log as a string'],
    ['a statement after a "/*" in a string (E3)', "const g = 'src/*'; await sql`DELETE FROM audit_log`; /* end */", ERASES],
    ['a statement after a "--" in a string (E5)', "const sep = '--'; await sql`DELETE FROM audit_log`;", ERASES],
    ['a statement after a "//" in a string', "const u = 'https://x'; await sql`DELETE FROM audit_log`;", ERASES],
  ])('%s', (_label, text, why) => {
    expect(violations(text)).toContain(why);
  });

  it.each([
    ['a read', 'sql`SELECT * FROM audit_log WHERE company_id = ${c}`'],
    ['the INSERT', 'sql`INSERT INTO audit_log (company_id, user_id) VALUES (${c}, ${u})`'],
    ['an upsert of another table beside a read of this one', 'sql`INSERT INTO x SELECT 1 FROM audit_log ON CONFLICT DO UPDATE SET y = 1`'],
    ['a line comment', '// DELETE FROM audit_log — refused since migration 880'],
    ['a block comment', '/* UPDATE audit_log SET x = 1 */'],
    ['a lock on another table', 'sql`SELECT id FROM supplier_invoices WHERE id = ${id} FOR UPDATE`'],
    ['a different table', 'sql`DELETE FROM admin_audit_log WHERE id = ${id}`'],
  ])('and passes %s', (_label, text) => {
    expect(violations(text)).toEqual([]);
  });

  it('strips SQL comments in a migration, but not a "--" inside an SQL string', () => {
    expect(migrationViolations('-- DELETE FROM audit_log\nSELECT 1;')).toEqual([]);
    expect(migrationViolations("SELECT '--'; DELETE FROM audit_log;")).toEqual(['erases']);
  });

  it.each([
    'GRANT UPDATE ON audit_log TO app_user;',
    'GRANT DELETE ON TABLE public.audit_log TO platform_admin;',
    'GRANT TRIGGER ON public.audit_log TO app_user;',
    'GRANT ALL ON public.approval_rules, public.audit_log TO app_user;',
    'GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA public TO app_user;',
    'GRANT ALL ON ALL TABLES IN SCHEMA "public" TO app_user;',
    'GRANT migration_admin TO app_user;',
    'GRANT pg_write_all_data TO platform_admin;',
    'ALTER TABLE public.audit_log OWNER TO app_user;',
    'ALTER TABLE audit_log DISABLE ROW LEVEL SECURITY;',
    'ALTER TABLE audit_log RENAME TO audit_log_old;',
    'CREATE TRIGGER t BEFORE INSERT ON public.audit_log FOR EACH ROW EXECUTE FUNCTION f();',
    'CREATE RULE r AS ON INSERT TO audit_log DO INSTEAD NOTHING;',
    'CREATE VIEW v AS SELECT * FROM audit_log; GRANT UPDATE ON v TO app_user;',
    'DROP TABLE audit_log; CREATE TABLE audit_log (id uuid);',
    'DELETE FROM audit_log WHERE created_at < now();',
  ])('a later migration: %s', (stmt) => {
    expect(migrationViolations(stmt)).not.toEqual([]);
  });

  it.each([
    'GRANT INSERT, SELECT ON audit_log TO app_user;',
    'GRANT SELECT ON admin_audit_log TO platform_admin;',
    'GRANT USAGE ON SCHEMA app TO app_user;',
    "INSERT INTO public.audit_log (company_id, user_id, action, entity_type, entity_id) VALUES ('x', 'y', 'create', 'z', 'w');",
  ])('and passes %s', (stmt) => {
    expect(migrationViolations(stmt)).toEqual([]);
  });
});
