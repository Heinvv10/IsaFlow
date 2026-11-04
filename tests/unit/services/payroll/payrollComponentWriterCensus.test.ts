/**
 * Every source file that writes payroll_employee_components is on a list, with the number of write statements it
 * holds. A new writer, or a second statement in a known one, has to be looked at: which guard does it take (paid
 * months, recurring overlap, the company lock)? The writers kept drifting apart (a once-off judged one way in assign,
 * another in Edit dates). Three censuses:
 *   1. direct statements (INSERT INTO, UPDATE [ONLY], DELETE FROM [ONLY], MERGE INTO, TRUNCATE, COPY .. FROM), per file,
 *      counted, with SQL and JS comments stripped first;
 *   2. indirect writers, over ALL files (the listed writers too), counted per file: the table named as a string
 *      literal (generic cloners and seeders), sql.unsafe, or a statement whose table name is interpolated;
 *   3. migration SQL (functions and triggers) that writes it.
 * Files read: .ts .tsx .js .mjs .mts .cts .sql .sh. The detectors are tested against each form they cover.
 *
 * NAMED LIMITS. This census is a backstop, not a proof: it reads source text. It does not see a table name split into
 * strings ('payroll_' + 'employee_components'), a name built at run time, EXECUTE format(...) or a dynamic statement
 * inside a migration function, or a write through a view. A DB-level guard (a trigger that refuses a row the writers'
 * checks would refuse) is the structural fix; it is not built here.
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
  [`${SERVICES}payrollRunPeriodInputs.ts`]: [3, "pay-run grid: its unapproved run month's once-off only, under the company lock; refuseAssignmentWrite on insert; audited"],
};

/** file -> [indirect forms it holds, why]. Files that name the table without (or besides) a statement of their own. */
const INDIRECT: Record<string, [number, string]> = {
  'scripts/ci/golden/cloneCompany.ts': [2, 'golden-path sandbox cloner: copies the table by name for a clone company, dev/CI only'],
  'scripts/seed-payroll-data.ts': [6, 'dev seed script: batchInsert by table name into a dev database, never run against production'],
};

/** Migration files that write the table in a statement or a function body. None today. */
const MIGRATION_WRITERS: Record<string, string> = {};

const NAME = String.raw`(?:"?public"?\.)?"?${TABLE}\b`;
const STATEMENT = new RegExp(
  String.raw`\b(INSERT\s+INTO|UPDATE(\s+ONLY)?|DELETE\s+FROM(\s+ONLY)?|MERGE\s+INTO|TRUNCATE(\s+TABLE)?(\s+ONLY)?)\s+${NAME}`, 'gi');
const COPY_IN = new RegExp(String.raw`\bCOPY\s+${NAME}\s*(\([^)]*\)\s*)?FROM\b`, 'gi');

/** The text without its comments: a statement named in a comment is no statement, and a comment cannot hide one. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[\s;{}(),])\/\/[^\n]*/g, '$1 ').replace(/(^|\s)--[^\n]*/g, '$1 ');
}

const statementsIn = (text: string): number => {
  const c = code(text);
  return [...c.matchAll(STATEMENT)].length + [...c.matchAll(COPY_IN)].length;
};

const QUOTED = new RegExp(String.raw`['"\x60]${TABLE}['"\x60]`, 'g');
const UNSAFE = /\bunsafe\s*\(/g;
const INTERPOLATED = /\b(INSERT\s+INTO|UPDATE(\s+ONLY)?|DELETE\s+FROM(\s+ONLY)?|MERGE\s+INTO|TRUNCATE(\s+TABLE)?)\s+(?:"?\w+"?\.)?["'\x60]?\$\{/gi;

/** Indirect forms in a file that names the table: its string literals, sql.unsafe calls, interpolated-table statements. */
function indirectIn(text: string): number {
  const c = code(text);
  if (!c.includes(TABLE)) return 0;
  return [c.matchAll(QUOTED), c.matchAll(UNSAFE), c.matchAll(INTERPOLATED)].reduce((n, m) => n + [...m].length, 0);
}

const tracked = execFileSync('git', ['ls-files', 'src', 'pages', 'scripts'], { cwd: ROOT, encoding: 'utf8' }).split('\n');
const READ = /\.(ts|tsx|js|mjs|mts|cts|sql|sh)$/;
const sources = tracked.filter((f) => READ.test(f) && !f.startsWith('scripts/migrations/'));
const migrations = tracked.filter((f) => f.startsWith('scripts/migrations/') && READ.test(f));
const read = (f: string) => readFileSync(ROOT + f, 'utf8');

describe('writers of payroll_employee_components', () => {
  it('direct statements: exactly the listed files, each with its pinned count', () => {
    const found = Object.fromEntries(sources.map((f) => [f, statementsIn(read(f))]).filter(([, n]) => (n as number) > 0));
    expect(found).toEqual(Object.fromEntries(Object.entries(WRITERS).map(([f, [n]]) => [f, n])));
  });

  it('indirect forms (string literal, sql.unsafe, interpolated table), in ALL files: exactly the listed files, each counted', () => {
    const found = Object.fromEntries(sources.map((f) => [f, indirectIn(read(f))]).filter(([, n]) => (n as number) > 0));
    expect(found).toEqual(Object.fromEntries(Object.entries(INDIRECT).map(([f, [n]]) => [f, n])));
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
    ['a comment cannot hide one (block comment between the words)', `UPDATE /* x */ ${TABLE} SET a = 1`, 1],
    ['a statement named in a block comment is none', `/* UPDATE ${TABLE} SET a = 1 */ SELECT 1`, 0],
    ['a statement named in a line comment is none', `// DELETE FROM ${TABLE}\nconst a = 1;`, 0],
    ['a statement named in an SQL comment is none', `SELECT 1 -- INSERT INTO ${TABLE} (a) VALUES (1)\n`, 0],
    ['DELETE FROM ONLY', `DELETE FROM ONLY ${TABLE} WHERE id = 1`, 1],
    ['TRUNCATE', `TRUNCATE ${TABLE}`, 1],
    ['TRUNCATE TABLE ONLY', `TRUNCATE TABLE ONLY ${TABLE} CASCADE`, 1],
    ['COPY FROM', `COPY ${TABLE} FROM '/tmp/x.csv'`, 1],
    ['COPY with a column list', `COPY public.${TABLE} (id, amount) FROM STDIN`, 1],
    ['COPY TO is an export, not a write', `COPY ${TABLE} TO '/tmp/x.csv'`, 0],
  ])('%s', (_name, text, n) => {
    expect(statementsIn(text)).toBe(n);
  });

  it.each([
    ['the table as a string literal (a generic writer)', `await batchInsert('${TABLE}', rows)`, 1],
    ['the table in a double-quoted literal', `const t = "${TABLE}";`, 1],
    ['the table in a template literal', `const t = \`${TABLE}\`;`, 1],
    ['sql.unsafe next to the table name', `await sql.unsafe(\`UPDATE \${t} SET a = 1\`); // ${TABLE}\nconst s = 'x'; /* ${TABLE} */ ${TABLE}`, 2],
    ['an interpolated table name', `const T = '${TABLE}'.length; await sql\`UPDATE \${sql(T)} SET a = 1\``, 2],
    ['an interpolated table after a schema', `// ${TABLE}\nconst q = \`UPDATE public.\${t} SET a = 1\`; const n = '${TABLE}';`, 2],
    ['an interpolated table inside quotes', `const q = \`INSERT INTO "\${t}" (a) VALUES (1)\`; const n = '${TABLE}';`, 2],
    ['two literals count twice', `f('${TABLE}'); g("${TABLE}");`, 2],
  ])('indirect: %s', (_name, text, n) => {
    expect(indirectIn(text)).toBe(n);
  });

  it('a file that only reads the table, or does not name it, has no indirect form', () => {
    expect(indirectIn(`SELECT * FROM ${TABLE} WHERE id = 1`)).toBe(0);
    expect(indirectIn(`await sql.unsafe('UPDATE other SET a = 1')`)).toBe(0);
    expect(indirectIn(`// '${TABLE}' only in a comment`)).toBe(0);
  });

  it.each(['a.ts', 'a.tsx', 'a.js', 'a.mjs', 'a.mts', 'a.cts', 'a.sql', 'a.sh'])('%s is read', (name) => {
    expect(READ.test(name)).toBe(true);
  });

  it('a migration function body that writes it is a statement', () => {
    expect(statementsIn(`CREATE FUNCTION f() RETURNS trigger AS $$ BEGIN\n  UPDATE ${TABLE} SET a = 1;\n  RETURN NEW; END $$ LANGUAGE plpgsql;`)).toBe(1);
  });
});
