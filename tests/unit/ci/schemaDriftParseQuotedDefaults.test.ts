/**
 * The 11-05 production deploy applied migration 954 and then failed the
 * schema-drift audit with "Missing columns: budget_control_settings: 100":
 * the parser split a CREATE TABLE column list on the comma inside the string
 * literal of `DEFAULT '{80,100,120}'` and read `100` as a column name. Commas
 * inside single-quoted literals (with '' escapes) and inside parentheses must
 * not split column definitions.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseExpectedSchema } from '../../../scripts/lib/schemaDriftParse';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function parseSql(sql: string): Map<string, Set<string>> {
  const dir = mkdtempSync(join(tmpdir(), 'drift-quoted-'));
  dirs.push(dir);
  writeFileSync(join(dir, '001_t.sql'), sql);
  return parseExpectedSchema(dir);
}
const cols = (m: Map<string, Set<string>>, t: string): string[] => [...(m.get(t) ?? [])].sort();

describe('schema-drift parser: commas inside quoted literals', () => {
  it('a quoted array default does not split the column list', () => {
    const m = parseSql(`CREATE TABLE IF NOT EXISTS q_arr (
      id UUID PRIMARY KEY,
      default_thresholds NUMERIC[] NOT NULL DEFAULT '{80,100,120}',
      updated_by VARCHAR(255)
    );`);
    expect(cols(m, 'q_arr')).toEqual(['default_thresholds', 'id', 'updated_by']);
  });

  it("a quoted string with a comma, a '' escape and a ( inside it", () => {
    const m = parseSql(`CREATE TABLE q_str (
      a TEXT DEFAULT 'a,b',
      b TEXT DEFAULT 'it''s, here',
      c TEXT DEFAULT 'one, (two',
      d TEXT DEFAULT ')',
      e INT
    );`);
    expect(cols(m, 'q_str')).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('a quoted segment that looks like a column or a constraint is not one', () => {
    const m = parseSql(`CREATE TABLE q_fake (
      note TEXT DEFAULT 'x, extra_col TEXT, constraint bad',
      real_col INT
    );`);
    expect(cols(m, 'q_fake')).toEqual(['note', 'real_col']);
  });

  it('a multi-line CHECK with parentheses, BETWEEN and a comma in a function call', () => {
    const m = parseSql(`CREATE TABLE q_chk (
      company_id UUID PRIMARY KEY,
      check_policy TEXT NOT NULL DEFAULT 'warn' CHECK (check_policy IN ('off', 'warn', 'block')),
      default_thresholds NUMERIC[] NOT NULL DEFAULT '{80,100,120}',
      CONSTRAINT q_chk_thresholds CHECK (
        array_ndims(default_thresholds) = 1 AND cardinality(default_thresholds) BETWEEN 1 AND 10
        AND array_position(default_thresholds, NULL) IS NULL
        AND 0 < ALL (default_thresholds) AND 1000 >= ALL (default_thresholds)),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );`);
    expect(cols(m, 'q_chk')).toEqual(['check_policy', 'company_id', 'default_thresholds', 'updated_at']);
  });

  it('migration 954 declares budget_control_settings with its real columns and none named 100', () => {
    const got = cols(parseExpectedSchema(), 'budget_control_settings');
    expect(got).not.toContain('100');
    expect(got).toEqual(expect.arrayContaining([
      'alert_email_enabled', 'check_policy', 'company_id', 'default_thresholds', 'updated_at', 'updated_by',
    ]));
  });
});

/**
 * The scan cannot read every SQL quoting form. What it cannot read must fail the audit LOUDLY: a
 * quote left open swallows every later column of the table, and a column missing from the model
 * is a column the audit stops checking (a false OK at deploy).
 */
describe('schema-drift parser: forms it cannot read fail loudly', () => {
  it("an E'' backslash escape (E'it\\'s') throws, naming the table", () => {
    const sql = "CREATE TABLE q_esc (\n  x TEXT DEFAULT E'it\\'s',\n  y INT,\n  z INT\n);";
    expect(() => parseSql(sql)).toThrow(/unbalanced quote\/parenthesis in CREATE TABLE q_esc/);
  });

  it("a -- inside a literal (cut by the comment strip) throws, naming the table", () => {
    const sql = "CREATE TABLE q_dash (\n  p TEXT DEFAULT 'a--b',\n  q INT,\n  r INT\n);";
    expect(() => parseSql(sql)).toThrow(/unbalanced quote\/parenthesis in CREATE TABLE q_dash/);
  });

  it('a stray closing parenthesis throws, naming the table', () => {
    const sql = 'CREATE TABLE q_paren (\n  a INT CHECK (a > 0)),\n  b INT\n);';
    expect(() => parseSql(sql)).toThrow(/unbalanced quote\/parenthesis in CREATE TABLE q_paren/);
  });

  it('a stray opening parenthesis throws, naming the table', () => {
    const sql = 'CREATE TABLE q_open (\n  a INT CHECK ((a > 0),\n  b INT\n);';
    expect(() => parseSql(sql)).toThrow(/unbalanced quote\/parenthesis in CREATE TABLE q_open/);
  });

  it('a balanced table next to the failing one is not what is reported', () => {
    const sql = "CREATE TABLE ok_t (a INT);\nCREATE TABLE bad_t (\n  x TEXT DEFAULT 'a--b',\n  y INT\n);";
    expect(() => parseSql(sql)).toThrow(/CREATE TABLE bad_t/);
  });
});
