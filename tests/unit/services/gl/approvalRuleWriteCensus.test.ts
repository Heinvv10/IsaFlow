/**
 * R-035 N1b (B, migration 881): approval_rules and approval_enforcement are
 * written only through their SECURITY DEFINER functions, and only
 * gl/approvalRuleWrites.ts calls them.
 *
 * After 881 no role but each table's owner may INSERT, UPDATE, DELETE,
 * TRUNCATE or lock (`FOR UPDATE` / `FOR SHARE` need UPDATE) either table, so
 * any other writer 500s at runtime with 42501. This census finds one before
 * it ships: by TABLE, over the source tree on DISK (an untracked new writer
 * counts). Migrations are the owner's and may write them (the 38 NULL-company
 * templates were seeded that way); a later migration that hands a write grant
 * back, grants app_user or platform_admin a role, or moves a table's or a
 * writer's owner would undo 881, so those are refused.
 *
 * A TEXT check, with approvalRequestWriteCensus's limits (a grant or a write
 * built at run time slips past it); r035-n1b-rules-catalog reads the live
 * catalogue against DATABASE_URL.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, migrationNumber, sourceFiles, stripComments, withoutSqlComments } from '../../helpers/sourceCensus';

const MIGRATIONS = 'scripts/migrations/sql/';
const WRITERS_FILE = 'src/modules/accounting/services/gl/approvalRuleWrites.ts';
const DEFINERS_FROM = 881;

const TABLE = String.raw`(?:only\s+)?(?:"?public"?\s*\.\s*)?"?approval_(?:rules|enforcement)"?\b`;
const WRITE = new RegExp(String.raw`\b(?:insert\s+into|update|delete\s+from|truncate(?:\s+table)?|merge\s+into|copy)\s+${TABLE}`, 'i');
const LOCK = /\bfor\s+(?:no\s+key\s+update|key\s+share|update|share)\b/i;
const CALL = /\bapproval_(?:rule_(?:lock|create|update|delete)|enforcement_set)\s*\(/i;
const QUOTED = /['"`]approval_(?:rules|enforcement)['"`]/;

/** Every reason `text` breaks the census (empty: none). */
export function violations(text: string, file = 'x.ts'): string[] {
  const code = stripComments(text, file);
  const out: string[] = [];
  if (WRITE.test(code) || WRITE.test(withoutSqlComments(code))) out.push('writes approval_rules or approval_enforcement');
  if (QUOTED.test(code)) out.push('names approval_rules or approval_enforcement as a string');
  for (const chunk of code.split(/`/)) {
    if (/\bapproval_(?:rules|enforcement)\b/i.test(chunk) && LOCK.test(chunk)) out.push('locks approval_rules or approval_enforcement');
  }
  if (CALL.test(code)) out.push('calls a rule or switch writer');
  return out;
}

/**
 * Read and found not to be statements: the bank-control check matches the
 * switch's AUDIT rows by `entity_type = 'approval_enforcement'`. A new one is
 * a new reason to look.
 */
const KNOWN = [
  'src/modules/accounting/services/ap/supplierBankBaseline.ts: names approval_rules or approval_enforcement as a string',
  // Step 3 (890): 'approval_enforcement' is an entity_changes.entity_type, read-only; no statement.
  'src/modules/accounting/services/core/entityChanges/entityChangeQuery.ts: names approval_rules or approval_enforcement as a string',
  'src/modules/accounting/services/core/entityChanges/entityChangeTypes.ts: names approval_rules or approval_enforcement as a string',
];

const REGRANT = [
  /\bgrant\b[^;]*\b(?:insert|update|delete|truncate|trigger|all)\b[^;]*\bon\s+(?:table\s+)?(?:[\w".\s]+,\s*)*(?:public\.)?"?approval_(?:rules|enforcement)\b/i,
  /\bgrant\b[^;]*\bon\s+all\s+tables\s+in\s+schema\s+public\b/i,
  /\bgrant\s+(?![^;]*\bon\b)[^;]*\bto\s+[^;]*\b(?:app_user|platform_admin)\b/i,
  /\balter\s+table\s+(?:only\s+)?(?:if\s+exists\s+)?(?:public\.)?"?approval_(?:rules|enforcement)"?\s+owner\b/i,
  /\balter\s+function\s+(?:public\.)?approval_(?:rule|enforcement)_\w+\s*\([^)]*\)\s+owner\b/i,
  // A view over either table is written through with its OWNER's rights (R3-1).
  /\bcreate\s+(?:or\s+replace\s+)?(?:(?:temp|temporary|recursive|materialized)\s+)*view\b[^;]*\bapproval_(?:rules|enforcement)\b/i,
];
/**
 * Migrations before 881 that match a re-grant pattern: the schema-wide grants
 * to app_user (348) and platform_admin (352). 881 revokes after them, so they
 * no longer reach either table; a new one is a reason to look.
 */
const KNOWN_REGRANTS = ['348_rls_and_auth_helpers.sql', '352_platform_admin_role.sql'];
const regrants = (file: string, text: string) => REGRANT.some((re) => re.test(stripComments(text, file)));

describe('approval_rules / approval_enforcement writers (census by table)', () => {
  it('no source file but approvalRuleWrites.ts writes or locks either table, or calls their writers', () => {
    const found = sourceFiles()
      .filter(({ file }) => !file.startsWith(MIGRATIONS))
      .flatMap(({ file, text }) => violations(text, file).map((why) => `${file}: ${why}`));
    expect(found).toEqual([...KNOWN, `${WRITERS_FILE}: calls a rule or switch writer`].sort());
  });

  it('the writers file calls each of the five functions', () => {
    const text = stripComments(readFileSync(path.join(ROOT, WRITERS_FILE), 'utf8'), WRITERS_FILE);
    for (const fn of ['approval_rule_lock', 'approval_rule_create', 'approval_rule_update', 'approval_rule_delete', 'approval_enforcement_set']) {
      expect(text, fn).toMatch(new RegExp(String.raw`\b${fn}\(`));
    }
  });

  it('the definer migration exists (this census is anchored to it)', () => {
    expect(sourceFiles().filter(({ file }) => file.startsWith(MIGRATIONS) && migrationNumber(file) === DEFINERS_FROM)
      .map(({ file }) => path.basename(file))).toEqual(['881_approval_rule_enforcement_definer_writes.sql']);
  });

  it('no migration after 881 hands a write privilege back, grants a runtime role a role, or moves an owner', () => {
    const found = sourceFiles()
      // NaN (a file with no NNN_ prefix) counts as after 881: unknown is judged, not skipped.
      .filter(({ file }) => file.startsWith(MIGRATIONS) && !(migrationNumber(file) <= DEFINERS_FROM))
      .filter(({ file, text }) => regrants(file, text))
      .map(({ file }) => file);
    expect(found).toEqual([]);
  });

  it('the migrations up to 881 that match a re-grant pattern are the known ones (a new one is a reason to look)', () => {
    const found = sourceFiles()
      .filter(({ file }) => file.startsWith(MIGRATIONS) && migrationNumber(file) <= DEFINERS_FROM)
      .filter(({ file, text }) => regrants(file, text))
      .map(({ file }) => path.basename(file));
    expect(found.sort()).toEqual(KNOWN_REGRANTS);
  });
});

describe('the census detects (counterexamples)', () => {
  it.each([
    ['an UPDATE of a rule', 'await sql`UPDATE approval_rules SET is_active = false WHERE id = ${id}`'],
    ['a schema-qualified DELETE of the switch', "client.query('DELETE FROM public.approval_enforcement WHERE company_id = $1')"],
    ['a quoted INSERT', 'sql`INSERT INTO "approval_rules" (name) VALUES (${n})`'],
    ['a TRUNCATE', "pool.query('TRUNCATE TABLE approval_enforcement')"],
    ['a row lock', 'sql`SELECT * FROM approval_rules WHERE id = ${id} FOR UPDATE`'],
    ['a FOR SHARE in a join', 'sql`SELECT 1 FROM approval_enforcement e JOIN companies c ON true FOR SHARE`'],
    ['a dynamic table name', "for (const t of ['bills', 'approval_rules']) await sql.unsafe(`DELETE FROM ${t}`)"],
    ['a direct call of a writer', 'sql`SELECT * FROM approval_enforcement_set(${c}, ${t}, false, ${u})`'],
    ['an SQL comment between the verb and the table', 'sql`DELETE FROM /* x */ approval_rules WHERE id = ${id}`'],
  ])('%s', (_label, text) => {
    expect(violations(text)).not.toEqual([]);
  });

  it.each([
    ['config/x.sh', 'psql -c "DELETE FROM approval_rules WHERE true"'],
    ['scripts/x.py', 'cur.execute("UPDATE approval_enforcement SET company_id = %s", (c,))'],
    ['x.sql', 'TRUNCATE approval_rules; -- the comment is stripped, the statement is not'],
  ])('and judges a %s file by its language', (file, text) => {
    expect(violations(text, file)).toContain('writes approval_rules or approval_enforcement');
  });

  it.each([
    ['a read', 'sql`SELECT * FROM approval_rules WHERE company_id = ${c}`'],
    ['a comment', '// UPDATE approval_rules — now approval_rule_update (migration 881)'],
    ['a lock on another table', 'sql`SELECT id FROM supplier_invoices WHERE id = ${id} FOR UPDATE`'],
    ['a helper with a writer-like prefix', 'sql`SELECT approval_rule_strictest_rank(${c}, ${t}, ${a})`'],
  ])('and passes %s', (_label, text) => {
    expect(violations(text)).toEqual([]);
  });

  it.each([
    'GRANT UPDATE ON approval_rules TO app_user;',
    'GRANT DELETE ON TABLE public.approval_enforcement TO platform_admin;',
    'GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA public TO app_user;',
    'GRANT migration_admin TO app_user;',
    'ALTER TABLE public.approval_enforcement OWNER TO app_user;',
    'ALTER FUNCTION public.approval_rule_update(uuid) OWNER TO app_user;',
    'CREATE VIEW zz_ar AS SELECT * FROM approval_rules;',
    'CREATE OR REPLACE VIEW public.zz AS SELECT e.* FROM public.approval_enforcement e;',
  ])('a re-grant or ownership change in a later migration: %s', (stmt) => {
    expect(REGRANT.some((re) => re.test(stmt))).toBe(true);
  });

  it.each(['GRANT SELECT ON approval_rules TO app_user;', 'GRANT USAGE ON SCHEMA app TO app_user;'])('and passes %s', (stmt) => {
    expect(REGRANT.some((re) => re.test(stmt))).toBe(false);
  });
});
