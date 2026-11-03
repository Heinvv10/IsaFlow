/**
 * Every source file that writes payroll_employee_components is on a list, with the number of write statements it
 * holds. A new writer, or a second statement in a known one, has to be looked at: which guard does it take (paid
 * months, recurring overlap, the company lock)? The writers kept drifting apart (a once-off judged one way in assign,
 * another in Edit dates). Three censuses:
 *   1. direct statements (INSERT INTO, UPDATE [ONLY], DELETE FROM, MERGE INTO), per file, counted;
 *   2. indirect writers: a file naming the table as a string literal (generic cloners and seeders), or building the
 *      statement with sql.unsafe or an interpolated table name next to the table's name;
 *   3. migration SQL (functions and triggers) that writes it.
 * The detectors are tested against every evasion form: each must be seen.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const ROOT = new URL('../../../../', import.meta.url).pathname;
const SERVICES = 'src/modules/accounting/services/payroll/';
const TABLE = 'payroll_employee_components';

/** file -> [write statements it holds, the guard it carries]. */
const WRITERS: Record<string, [number, string]> = {
  [`${SERVICES}payrollEmployeeComponentService.ts`]: [1, 'assign: refuseAssignmentWrite under the company lock'],
  [`${SERVICES}payrollBatchPost.ts`]: [1, 'batch post: refuseAssignmentWrite under the company lock'],
  [`${SERVICES}payPackageService.ts`]: [1, 'package apply: refuseAssignmentWrite under the company lock'],
  [`${SERVICES}payPackageSupersede.ts`]: [2, 'package apply cut: paidPeriodChanged under the company lock'],
  [`${SERVICES}payrollComponentDateEdit.ts`]: [1, 'Edit dates / End: paid months and recurring overlap under the company lock'],
};

/** Files that name the table without a statement of their own (dev tooling, not the request path). */
const INDIRECT: Record<string, string> = {
  'scripts/ci/golden/cloneCompany.ts': 'golden-path sandbox cloner: copies the table by name for a clone company, dev/CI only',
  'scripts/seed-payroll-data.ts': 'dev seed script: batchInsert by table name into a dev database, never run against production',
};

/** Migration files that write the table in a statement or a function body. None today. */
const MIGRATION_WRITERS: Record<string, string> = {};

const STATEMENT = new RegExp(
  String.raw`\b(INSERT\s+INTO|UPDATE(\s+ONLY)?|DELETE\s+FROM|MERGE\s+INTO)\s+(?:"?public"?\.)?"?${TABLE}\b`, 'gi');

const statementsIn = (text: string): number => [...text.matchAll(STATEMENT)].length;

/** The table named as a string literal, or in sql.unsafe, or a statement whose table name is interpolated. */
function indirectIn(text: string): boolean {
  if (!text.includes(TABLE)) return false;
  return new RegExp(String.raw`['"\x60]${TABLE}['"\x60]`).test(text)
    || /\bunsafe\s*\(/.test(text)
    || /\b(INSERT\s+INTO|UPDATE(\s+ONLY)?|DELETE\s+FROM|MERGE\s+INTO)\s+\$\{/i.test(text);
}

const tracked = execFileSync('git', ['ls-files', 'src', 'pages', 'scripts'], { cwd: ROOT, encoding: 'utf8' }).split('\n');
const sources = tracked.filter((f) => /\.(ts|tsx|js|mjs)$/.test(f) && !f.startsWith('scripts/migrations/'));
const migrations = tracked.filter((f) => f.startsWith('scripts/migrations/') && /\.(sql|ts|js|mjs)$/.test(f));
const read = (f: string) => readFileSync(ROOT + f, 'utf8');

describe('writers of payroll_employee_components', () => {
  it('direct statements: exactly the listed files, each with its pinned count', () => {
    const found = Object.fromEntries(sources.map((f) => [f, statementsIn(read(f))]).filter(([, n]) => (n as number) > 0));
    expect(found).toEqual(Object.fromEntries(Object.entries(WRITERS).map(([f, [n]]) => [f, n])));
  });

  it('indirect writers (string literal, sql.unsafe, interpolated table): exactly the listed files', () => {
    const found = sources.filter((f) => !(f in WRITERS) && indirectIn(read(f))).sort();
    expect(found).toEqual(Object.keys(INDIRECT).sort());
  });

  it('migration SQL that writes it: exactly the listed files', () => {
    const found = migrations.filter((f) => statementsIn(read(f)) > 0).sort();
    expect(found).toEqual(Object.keys(MIGRATION_WRITERS).sort());
  });
});

describe('the detectors see every evasion form', () => {
  it.each([
    ['plain INSERT', `INSERT INTO ${TABLE} (a) VALUES (1)`],
    ['lower case', `insert into ${TABLE} (a) values (1)`],
    ['newline between the words', `INSERT\n  INTO\n  ${TABLE}`],
    ['UPDATE', `UPDATE ${TABLE} SET a = 1`],
    ['UPDATE ONLY', `UPDATE ONLY ${TABLE} SET a = 1`],
    ['DELETE FROM', `DELETE FROM ${TABLE} WHERE id = 1`],
    ['MERGE INTO', `MERGE INTO ${TABLE} t USING s ON t.id = s.id`],
    ['schema-qualified', `UPDATE public.${TABLE} SET a = 1`],
    ['quoted schema and table', `UPDATE "public"."${TABLE}" SET a = 1`],
    ['quoted table', `DELETE FROM "${TABLE}"`],
  ])('a statement: %s', (_name, text) => {
    expect(statementsIn(text)).toBe(1);
  });

  it('counts each statement', () => {
    expect(statementsIn(`UPDATE ${TABLE} SET a = 1; DELETE FROM ${TABLE}; INSERT INTO ${TABLE} (a) VALUES (1)`)).toBe(3);
  });

  it('reads the table per statement: another table in the same file is not this one', () => {
    expect(statementsIn(`INSERT INTO payroll_employee_audit (a) VALUES (1); SELECT * FROM ${TABLE}`)).toBe(0);
    expect(statementsIn(`UPDATE ${TABLE}_archive SET a = 1`)).toBe(0);
  });

  it.each([
    ['the table as a string literal (a generic writer)', `await batchInsert('${TABLE}', rows)`],
    ['the table in a double-quoted literal', `const t = "${TABLE}";`],
    ['the table in a template literal', `const t = \`${TABLE}\`;`],
    ['sql.unsafe building the statement', `await sql.unsafe(\`UPDATE \${t} SET a = 1\`); // ${TABLE}`],
    ['an interpolated table name', `const T = '${TABLE}'.length; await sql\`UPDATE \${sql(T)} SET a = 1\``],
  ])('an indirect writer: %s', (_name, text) => {
    expect(indirectIn(text)).toBe(true);
  });

  it('a file that only reads the table, or does not name it, is not indirect', () => {
    expect(indirectIn(`SELECT * FROM ${TABLE} WHERE id = 1`)).toBe(false);
    expect(indirectIn(`await sql.unsafe('UPDATE other SET a = 1')`)).toBe(false);
  });

  it('a migration function body that writes it is a statement', () => {
    expect(statementsIn(`CREATE FUNCTION f() RETURNS trigger AS $$ BEGIN\n  UPDATE ${TABLE} SET a = 1;\n  RETURN NEW; END $$ LANGUAGE plpgsql;`)).toBe(1);
  });
});
