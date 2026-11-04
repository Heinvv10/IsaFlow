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

  it('migration 954 declares budget_control_settings without a column named 100', () => {
    const expected = parseExpectedSchema();
    expect(cols(expected, 'budget_control_settings')).toEqual([
      'alert_email_enabled', 'check_policy', 'company_id', 'default_thresholds', 'updated_at', 'updated_by',
    ]);
  });
});
