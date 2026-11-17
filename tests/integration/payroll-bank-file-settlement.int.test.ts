/**
 * Salary bank file (wave 6 BF): what a confirmed pre-reopen file leaves to settle (review #1524 D-3 and E-5, folded in).
 * Per employee, never netted: each employee's current approved net less what the file paid them
 * (payroll_bank_file_items). Owed and overpaid are reported apart, naming the people; an employee new to the run is
 * owed in full, one no longer on it was overpaid in full. Plus the items table's own guard (review #1524 round 4,
 * F-2/F-3 folded in): an item names this company's employee, with a line on the file's run, paying exactly its net.
 *
 * Disposable DB only (rig -> assertDisposable).
 */
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rig } from './brkr.helpers';
import {
  act, approvedRun, bank, cleanup, enable, generate, payingAccount, reason, status, type R,
} from './payroll-bank-file.helpers';

let a: R;
const emp: { employee: string; salaryRow: string }[] = [];
const BASE = [25000, 18000];
type Entry = { employeeNumber: string; name: string; cents: number };

/** Line nets in cents per employee number. */
const nets = async (run: string): Promise<Record<string, number>> => Object.fromEntries((await a.pool.query(
  `SELECT e.employee_number, round(l.net_pay * 100)::int AS c FROM payroll_run_lines l JOIN payroll_employees e ON e.id = l.employee_id
    WHERE l.run_id = $1`, [run])).rows.map((r) => [r.employee_number, r.c]));

/** Generate, change salaries, reopen, recalculate, reverse the first journal, approve again, confirm the first file. */
async function confirmAfter(month: number, salaries: number[], between?: () => Promise<void>) {
  const run = await approvedRun(a, month);
  const before = await nets(run);
  const first = await generate(a, run);
  expect(first.statusCode).toBe(200);
  for (const [i, s] of salaries.entries()) await a.setSalary(emp[i]!.salaryRow, s);
  if (between) await between();
  const je = String((await a.header(run)).journal_entry_id);
  expect((await a.api.reopen(run)).statusCode).toBe(200);
  expect((await a.api.calculate(run)).statusCode).toBe(200);
  expect((await a.api.reverse(je)).statusCode).toBe(200);
  await a.authorise(run);
  expect((await a.api.approve(run)).statusCode).toBe(200);
  const after = await nets(run);
  const ok = await act(a, run, String(first.body.data!.id), 'confirm');
  for (const [i, s] of BASE.entries()) await a.setSalary(emp[i]!.salaryRow, s);
  return { run, before, after, ok, file: first.body.data! };
}
const byNumber = (list: Entry[]) => Object.fromEntries(list.map((e) => [e.employeeNumber, e.cents]));

beforeAll(async () => {
  a = await rig('bank-file-settlement');
  await a.setup();
  emp.push(await a.employee(BASE[0]!), await a.employee(BASE[1]!));
  await enable(a);
  await payingAccount(a);
  await bank(a, emp[0]!.employee, '4071234567');
  await bank(a, emp[1]!.employee, '1234567890', '470010');
}, 180_000);
afterAll(async () => { await cleanup(a); });

describe('what a confirmed pre-reopen file leaves to settle', () => {
  it('D-3 up: the employee paid more is owed the difference; nobody is overpaid', async () => {
    const { before, after, ok } = await confirmAfter(1, [40000, BASE[1]!]);
    const s = ok.body.data!.settlement;
    expect(byNumber(s.owedTo)).toEqual({ 'BRK-1': after['BRK-1']! - before['BRK-1']! });
    expect([s.overpaidCents, s.overpaidBy]).toEqual([0, []]);
  }, 300_000);

  it('D-3 down: the employee paid less was overpaid; nobody is owed', async () => {
    const { run, before, after } = await confirmAfter(2, [15000, BASE[1]!]);
    const s = (await status(a, run)).body.data!.files[0].settlement;
    expect(byNumber(s.overpaidBy)).toEqual({ 'BRK-1': before['BRK-1']! - after['BRK-1']! });
    expect([s.owedCents, s.owedTo]).toEqual([0, []]);
    expect(reason(await generate(a, run))).toBe('BANK_HAS_PAID');
  }, 300_000);

  it('E-5: A up and B down are reported apart, never netted', async () => {
    const { before, after, ok } = await confirmAfter(3, [30000, 13000]);
    const s = ok.body.data!.settlement;
    const owedA = after['BRK-1']! - before['BRK-1']!;
    const overB = before['BRK-2']! - after['BRK-2']!;
    expect(owedA).toBeGreaterThan(0);
    expect(overB).toBeGreaterThan(0);
    expect([s.owedCents, byNumber(s.owedTo)]).toEqual([owedA, { 'BRK-1': owedA }]);
    expect([s.overpaidCents, byNumber(s.overpaidBy)]).toEqual([overB, { 'BRK-2': overB }]);
  }, 300_000);

  it('an employee new to the run is owed in full; one no longer on it was overpaid in full', async () => {
    let added = '';
    const { run, before, after, ok } = await confirmAfter(4, BASE, async () => {
      added = (await a.employee(20000)).employee;
      await bank(a, added, '9988776655', '250655');
    });
    const s = ok.body.data!.settlement;
    expect(byNumber(s.owedTo)).toEqual({ 'BRK-3': after['BRK-3']! });
    expect(s.overpaidBy).toEqual([]);
    // BRK-2 leaves the run (its line removed): what the file paid them is now overpaid in full.
    await a.pool.query('DELETE FROM payroll_run_lines WHERE run_id = $1 AND employee_id = $2', [run, emp[1]!.employee]);
    const gone = (await status(a, run)).body.data!.files[0].settlement;
    expect(byNumber(gone.overpaidBy)).toEqual({ 'BRK-2': before['BRK-2']! });
    await a.pool.query('UPDATE payroll_employees SET is_active = false WHERE id = $1', [added]).catch(() => undefined);
  }, 300_000);

  it('F-2 / F-3: an item for another tenant\'s employee, an employee off the run, or a redistribution is refused', async () => {
    const other = await rig('bank-file-settlement-b');
    await other.setup();
    const foreign = (await other.employee(30000)).employee;
    try {
      const run = await approvedRun(a, 5);
      const n = await nets(run);
      const [n1, n2] = [n['BRK-1']!, n['BRK-2']!];
      const offRun = (await a.employee(12000)).employee; // created after the run: no line on it
      const asAppUser = async (items: [string, number][], role: 'app_user' | 'owner' = 'app_user') => {
        const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          if (role === 'app_user') await c.query('SET LOCAL ROLE app_user');
          await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: a.admin, role: 'authenticated' })]);
          await c.query("SELECT set_config('app.current_company_id', $1, true)", [a.company]);
          const f = (await c.query(
            `INSERT INTO payroll_bank_files (company_id, run_id, layout, sha256, line_count, total_cents, action_date, run_approved_at, created_by)
             SELECT company_id, id, 'fnb_obe_2023_02', repeat('d', 64), $2, $3, '2099-01-15', COALESCE(approved_at, approval_grandfathered_at), 'x'
               FROM payroll_run_headers WHERE id = $1 RETURNING id`, [run, items.length, items.reduce((t, [, c2]) => t + c2, 0)])).rows[0]!.id;
          await c.query(`INSERT INTO payroll_bank_file_items (company_id, file_id, employee_id, amount_cents)
                         SELECT $1, $2, e, c FROM unnest($3::uuid[], $4::bigint[]) AS t(e, c)`,
            [a.company, f, items.map(([e]) => e), items.map(([, c2]) => c2)]);
          await c.query('COMMIT');
          return 'committed';
        } catch (err) { await c.query('ROLLBACK'); return (err as Error).message; } finally { c.release(); await pool.end(); }
      };
      const refused = /exactly their net on the file's run/;
      expect(await asAppUser([[emp[0]!.employee, n1], [foreign, n2]])).toMatch(refused); // F-2: another tenant's employee
      // F-2 even with a (forged) line for that employee on this run: the employee must be this company's. As app_user, RLS
      // already hides the other tenant's employee from the guard; as a role that bypasses RLS (the owner), only the
      // guard's explicit company check refuses it.
      await a.pool.query('INSERT INTO payroll_run_lines (run_id, employee_id, net_pay) VALUES ($1, $2, $3)', [run, foreign, n2 / 100]);
      expect(await asAppUser([[emp[0]!.employee, n1], [foreign, n2]])).toMatch(refused);
      expect(await asAppUser([[emp[0]!.employee, n1], [foreign, n2]], 'owner')).toMatch(refused);
      await a.pool.query('DELETE FROM payroll_run_lines WHERE run_id = $1 AND employee_id = $2', [run, foreign]);
      expect(await asAppUser([[emp[0]!.employee, n1], [offRun, n2]])).toMatch(refused); // F-3: no line on the run
      expect(await asAppUser([[emp[0]!.employee, n1 + n2 - 100], [emp[1]!.employee, 100]])).toMatch(refused); // F-3: redistributed
      expect(await asAppUser([[emp[0]!.employee, n1], [emp[1]!.employee, n2]])).toBe('committed'); // the control: exact nets
      await a.pool.query('UPDATE payroll_employees SET is_active = false WHERE id = $1', [offRun]).catch(() => undefined);
    } finally { await other.teardown(); }
  }, 300_000);
});
