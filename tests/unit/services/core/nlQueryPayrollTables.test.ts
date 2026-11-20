/**
 * #1656 round 7 (security hook MEDIUM): the natural-language query refuses, for a person without Payroll read, any query that NAMES a table
 * carrying employee pay or HR data, whatever columns it picks: `*`, a whole-row reference, row_to_json / to_jsonb of the row, a plain
 * column select, a schema prefix, quotes, an alias, a CTE or a subquery. Every allowlisted table has an explicit decision here.
 */
import { describe, expect, it } from 'vitest';
import { ALLOWED_TABLES } from '@/modules/accounting/services/core/nlQueryValidationService';
import { PAYROLL_NL_TABLES, sqlTouchesPayrollTables, withoutPayrollTables } from '@/modules/accounting/services/core/nlQueryPayrollTables';
import { SCHEMA_TABLES } from '@/modules/accounting/services/core/nlQuerySchemaTables';

const HR_TABLES = ['employees', 'payslips', 'payroll_runs', 'leave_balances', 'leave_applications', 'project_time_entries'];

describe.each(HR_TABLES)('%s', (t) => {
  it.each([
    ['star', `SELECT * FROM ${t}`],
    ['qualified star', `SELECT x.* FROM ${t} x`],
    ['whole row', `SELECT x FROM ${t} x`],
    ['row_to_json', `SELECT row_to_json(x) FROM ${t} x`],
    ['to_jsonb', `SELECT to_jsonb(x) FROM ${t} AS x`],
    ['json_agg of the row', `SELECT json_agg(${t}) FROM ${t}`],
    ['a plain column', `SELECT id FROM ${t} WHERE company_id = $1`],
    ['an aggregate', `SELECT COUNT(*) FROM ${t}`],
    ['schema prefix', `SELECT 1 FROM public.${t}`],
    ['quoted', `SELECT 1 FROM "${t}"`],
    ['uppercase', `SELECT 1 FROM ${t.toUpperCase()}`],
    ['a JOIN', `SELECT c.name FROM customers c JOIN ${t} x ON x.id = c.id`],
    ['a CTE', `WITH w AS (SELECT * FROM ${t}) SELECT COUNT(*) FROM w`],
    ['a subquery', `SELECT name FROM customers WHERE id IN (SELECT id FROM ${t})`],
  ])('refuses %s', (_, sql) => expect(sqlTouchesPayrollTables(sql)).toBe(true));
});

describe('what stays queryable', () => {
  it.each([
    // time_entries: `rate` is the price typed for the billed hour, `applied_rate` comes from the practice's rate tables (round 8)
    'SELECT SUM(hours * rate) FROM time_entries',
    'SELECT * FROM time_entries',
    'SELECT SUM(total_amount) FROM customer_invoices',
    'SELECT * FROM customers',
    'SELECT COUNT(*) FROM leave_types',
    'SELECT hours, entry_date FROM projects',
    'SELECT * FROM gl_journal_lines',
  ])('lets through: %s', (sql) => expect(sqlTouchesPayrollTables(sql)).toBe(false));
});

describe('the allowlist', () => {
  it('every table that holds employee pay or HR data is on the refusal list, and the list names only allowlisted or payroll tables', () => {
    expect([...PAYROLL_NL_TABLES].sort()).toEqual([...HR_TABLES].sort());
    for (const t of HR_TABLES.filter((x) => x !== 'payroll_runs' || ALLOWED_TABLES.has(x))) expect(ALLOWED_TABLES.has(t), t).toBe(true);
  });

  it('every OTHER allowlisted table is decided: none is named like payroll, HR, time, rate, salary or leave data', () => {
    const rest = [...ALLOWED_TABLES].filter((t) => !PAYROLL_NL_TABLES.has(t));
    expect(rest.filter((t) => /payroll|payslip|employee|staff|salary|wage|leave|timesheet|time_entr|irp5|emp201|hr_/i.test(t))).toEqual(['time_entries', 'leave_types']);
    // leave_types is the company's list of leave kinds (a name and a day count), not a person's leave; time_entries is a charge-out price list
    expect(sqlTouchesPayrollTables('SELECT * FROM leave_types')).toBe(false);
  });

  it('the prompt does not show any of them', () => {
    const shown = withoutPayrollTables(SCHEMA_TABLES).map((t) => t.name);
    for (const t of HR_TABLES) expect(shown).not.toContain(t);
  });
});
