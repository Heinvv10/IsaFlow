/**
 * Payroll journals tag each labour debit with the employee's cost centre in
 * gl_journal_lines.cc1_id (Hein, 2026-11-02: "post with CC1", no backfill),
 * so budgets by CC1 get real payroll actuals.
 *
 * Real routes throughout (withAuth, app_user, RLS) on the disposable fixture:
 * a run is approved (which posts its journal), the posted lines are read back,
 * the run is reopened and its journal reversed through the journal-entries
 * action route, and the reversal is read back. Also pinned: a preview taken
 * before an employee's centre moved cannot approve the new split (CC1 is in the
 * plan hash), and a recalculated run whose pay moved between two centres on ONE
 * account is not re-locked onto its old journal (CC1 is in the per-account
 * figures).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { rig } from './brkr.helpers';

let r: Awaited<ReturnType<typeof rig>>;
let acct5210 = '';
let wanda = '';
const cc = { a: crypto.randomUUID(), b: crypto.randomUUID(), c: crypto.randomUUID(), d: crypto.randomUUID(), old: crypto.randomUUID(), prj: crypto.randomUUID() };

type Row = { account_code: string; cc1_id: string | null; debit: number; credit: number };
/** Labour (debit) lines of a journal, as (account, CC1, cents). */
const lines = async (journalId: string): Promise<Row[]> => (await r.pool.query(
  `SELECT a.account_code, l.cc1_id::text AS cc1_id, l.debit::float8 AS debit, l.credit::float8 AS credit
     FROM gl_journal_lines l JOIN gl_accounts a ON a.id = l.gl_account_id
    WHERE l.journal_entry_id = $1 ORDER BY a.account_code, l.cc1_id NULLS LAST`, [journalId])).rows;
type Key = [string, string | null, ...unknown[]];
/** By account, then CC1 with untagged last — the order the plan posts in, whatever ids the centres drew. */
const sorted = <T extends Key>(xs: T[]): T[] => [...xs].sort((x, y) =>
  x[0].localeCompare(y[0]) || (x[1] === null ? 1 : 0) - (y[1] === null ? 1 : 0) || (x[1] ?? '').localeCompare(y[1] ?? ''));
const labour = (rows: Row[]) => sorted(rows.filter((l) => l.account_code.startsWith('52') && l.debit > 0)
  .map((l): [string, string | null, number] => [l.account_code, l.cc1_id, Math.round(l.debit * 100)]));
const allocate = async (employee: string, shares: Array<[string, number]>) => {
  await r.pool.query('DELETE FROM payroll_employee_cost_allocations WHERE employee_id = $1', [employee]);
  for (const [centre, pct] of shares) {
    await r.pool.query('INSERT INTO payroll_employee_cost_allocations (company_id, employee_id, cost_centre_id, percentage) VALUES ($1,$2,$3,$4)',
      [r.company, employee, centre, pct]);
  }
};

beforeAll(async () => {
  r = await rig('cc1'); await r.setup();
  acct5210 = await r.account('5210');
  for (const [id, code, type, active] of [
    [cc.a, 'CC-A', 'cc1', true], [cc.b, 'CC-B', 'cc1', true], [cc.c, 'CC-C', 'cc1', true], [cc.d, 'CC-D', 'cc1', true],
    [cc.old, 'CC-OLD', 'cc1', false], [cc.prj, 'PRJ-1', 'cc2', true],
  ] as const) {
    await r.pool.query('INSERT INTO cost_centres (id, company_id, code, name, cc_type, is_active) VALUES ($1,$2,$3,$3,$4,$5)', [id, r.company, code, type, active]);
  }
  // A, B, D and the inactive centre map to 5210; C and the CC2 project are unmapped (5200).
  for (const id of [cc.a, cc.b, cc.d, cc.old]) {
    await r.pool.query('INSERT INTO cost_centre_gl_mappings (company_id, cost_centre_id, expense_account_id) VALUES ($1,$2,$3)', [r.company, id, acct5210]);
  }
  wanda = (await r.employee(20000)).employee;                   // 60 / 40 over A and B: same account, two CC1s
  await allocate(wanda, [[cc.a, 60], [cc.b, 40]]);
  const centre = async (salary: number, id: string) =>
    r.pool.query('UPDATE payroll_employees SET cost_centre_id = $1 WHERE id = $2', [id, (await r.employee(salary)).employee]);
  await centre(10000, cc.old);                                  // inactive: 5210, untagged
  await centre(10000, cc.c);                                    // unmapped: 5200, keeps CC-C
  await centre(10000, cc.prj);                                  // a CC2: 5200, untagged
});
afterAll(async () => { await r.teardown(); });
// Each test starts from Wanda on A/B, so one failing mid-way cannot decide the next.
beforeEach(async () => { await allocate(wanda, [[cc.a, 60], [cc.b, 40]]); });

describe('payroll journal labour lines carry the employee\'s CC1', () => {
  it('posts CC1 on each labour line, and its reversal mirrors every line with the same CC1', async () => {
    const id = await r.calculatedRun(3);
    const p = await r.api.preview(id);
    expect(p.body.data!.blocker).toBeNull();
    const approved = await r.api.approveWith(id, p.body.data!.planHash);
    expect(approved.statusCode).toBe(200);
    const journalId = String(approved.body.data!.journalEntryId);

    const posted = await lines(journalId);
    const labourDebit = Math.round(p.body.data!.plan.lines.reduce((s: number, l: { debit: number }) => s + l.debit, 0) * 100);
    expect(labour(posted).map(([code, cc1]) => [code, cc1])).toEqual(sorted<Key>([
      ['5200', cc.c], ['5200', null], ['5210', cc.a], ['5210', cc.b], ['5210', null],
    ]));
    // Wanda's 60/40 lands to the cent on A and B; the whole labour cost ties to the plan.
    const [, , onA] = labour(posted).find(([code, cc1]) => code === '5210' && cc1 === cc.a)!;
    const [, , onB] = labour(posted).find(([code, cc1]) => code === '5210' && cc1 === cc.b)!;
    expect(Math.abs(onA - Math.round((onA + onB) * 0.6))).toBeLessThanOrEqual(1);
    expect(labour(posted).reduce((s, [, , c]) => s + Number(c), 0)).toBe(labourDebit);
    // Credits (control accounts) carry none.
    expect(posted.filter((l) => l.credit > 0).every((l) => l.cc1_id === null)).toBe(true);
    // The two centres the ledger would refuse as a CC1 are named, and still posted.
    const advisory = (approved.body.data!.advisories as Array<{ code: string; detail: string }>).find((a) => a.code === 'labour_cost_centre_untagged');
    expect(advisory?.detail).toMatch(/CC-OLD \(inactive\).*PRJ-1 \(a CC2, not a CC1\)|PRJ-1 \(a CC2, not a CC1\).*CC-OLD \(inactive\)/);

    expect((await r.api.reopen(id)).statusCode).toBe(200);
    expect((await r.api.reverse(journalId)).statusCode).toBe(200);
    const reversal = await lines(await r.contraOf(journalId));
    const mirror = sorted(reversal.filter((l) => l.account_code.startsWith('52'))
      .map((l): [string, string | null, number] => [l.account_code, l.cc1_id, Math.round(l.credit * 100)]));
    expect(mirror).toEqual(labour(posted));
    expect(reversal.filter((l) => l.account_code.startsWith('52')).every((l) => l.debit === 0)).toBe(true);
  });

  it('a preview taken before an employee\'s centre moved cannot approve the new split (CC1 is in the plan hash)', async () => {
    const id = await r.calculatedRun(4);
    const stale = (await r.api.preview(id)).body.data!.planHash;
    // B → D: both map to 5210, so every account and amount is unchanged; only the CC1 moves.
    await allocate(wanda, [[cc.a, 60], [cc.d, 40]]);
    const refused = await r.api.approveWith(id, stale);
    expect(refused.statusCode).toBe(409);
    expect((await r.header(id)).journal_entry_id).toBeNull();

    const fresh = await r.api.preview(id);
    expect(fresh.body.data!.planHash).not.toBe(stale);
    const approved = await r.api.approveWith(id, fresh.body.data!.planHash);
    expect(approved.statusCode).toBe(200);
    const cc1s = labour(await lines(String(approved.body.data!.journalEntryId))).filter(([code]) => code === '5210').map(([, cc1]) => cc1);
    expect(cc1s).toEqual(sorted<Key>([['5210', cc.a], ['5210', cc.d], ['5210', null]]).map(([, cc1]) => cc1));
  });

  it('a recalculated run whose pay moved between two centres on ONE account is not re-locked onto its old journal', async () => {
    const id = await r.calculatedRun(5);
    expect((await r.api.approve(id)).statusCode).toBe(200);
    expect((await r.api.reopen(id)).statusCode).toBe(200);
    // Recalculated with nothing changed: the tagged journal still matches, line for line, CC1 for CC1.
    expect((await r.api.calculate(id)).statusCode).toBe(200);
    expect((await r.api.preview(id)).body.data!.blocker).toBeNull();
    // Same accounts, same amounts — only Wanda's 40% moves from B to D — then recalculated.
    await allocate(wanda, [[cc.a, 60], [cc.d, 40]]);
    expect((await r.api.calculate(id)).statusCode).toBe(200);
    const p = await r.api.preview(id);
    expect(p.body.data!.blocker).toMatchObject({ code: 'recalculated_after_posting' });
  });
});
