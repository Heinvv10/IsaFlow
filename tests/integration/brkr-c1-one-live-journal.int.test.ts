/**
 * BRK-596 round 4 — CLAIM 1 "ONE LIVE JOURNAL". Each test asserts the claim; a red test is the break.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rig } from './brkr.helpers';

let r: Awaited<ReturnType<typeof rig>>;
beforeAll(async () => { r = await rig('c1'); await r.setup(); await r.employee(20000); });
afterAll(async () => { await r.teardown(); });

describe('CLAIM 1 — one live journal', () => {
  it('C1-A: an approved run never ends with NO journal in force (generic reverse of its journal)', async () => {
    const id = await r.calculatedRun(1);
    const a = await r.api.approve(id);
    expect(a.statusCode).toBe(200);
    const j1 = String(a.body.data!.journalEntryId);
    const rev = await r.api.reverse(j1);
    const end = { reverseStatus: rev.statusCode, header: await r.header(id), journals: await r.journals('01'), ledger: await r.ledger(1) };
    r.evidence('C1-A approved run after POST journal-entries-action reverse', end);
    // The claim: an approved run has a journal in force. Either the reversal is refused, or the run leaves 'approved'.
    const inForce = end.journals.filter((j) => j.status === 'posted' && !j.reversed && j.reversal_of_id == null);
    expect(end.header.status === 'approved' ? inForce.length : 1).toBe(1);
  });

  it('C1-B: the month is never in the ledger twice (replace, then reverse the OLD contra)', async () => {
    const id = await r.calculatedRun(2);
    const j1 = String((await r.api.approve(id)).body.data!.journalEntryId);
    expect((await r.api.reopen(id)).statusCode).toBe(200);
    expect((await r.api.reverse(j1)).statusCode).toBe(200);
    const contra = await r.contraOf(j1);
    const again = await r.api.approve(id); // PR: replaces j1 with a fresh journal
    const j2 = String(again.body.data?.journalEntryId);
    const before = await r.ledger(2);
    const rev2 = await r.api.reverse(contra); // generic route: reverse the reversal of j1
    const end = { approveAgain: again.statusCode, j1, j2, reverseContra: rev2.statusCode, message: r.msg(rev2),
      header: await r.header(id), journals: await r.journals('02'), ledgerBeforeReverse: before, ledger: await r.ledger(2) };
    r.evidence('C1-B replace then reverse the old contra', end);
    const plan = (await r.api.preview(id)).body.data?.plan;
    const labourOnce = plan?.totalDebit ?? end.journals.find((j) => j.id === j1)!.total_debit;
    expect(end.ledger['5200']).toBe(labourOnce);
  });

  it('C1-C: approve(replace) racing reverse(contra) — no 5xx, and the ledger holds the month once', async () => {
    const out: unknown[] = [];
    let worst = 0;
    let labour = 0;
    for (const month of [3, 4, 5, 6]) {
      const id = await r.calculatedRun(month);
      const j1 = String((await r.api.approve(id)).body.data!.journalEntryId);
      await r.api.reopen(id);
      await r.api.reverse(j1);
      const contra = await r.contraOf(j1);
      const p = await r.api.preview(id);
      labour = p.body.data?.plan.totalDebit ?? 0;
      const [ap, rv] = await Promise.all([r.api.approveWith(id, p.body.data?.planHash), r.api.reverse(contra)]);
      const led = await r.ledger(month);
      const h = await r.header(id);
      out.push({ month, approve: ap.statusCode, approveMsg: r.msg(ap), reverseContra: rv.statusCode, status: h.status, labourInLedger: led['5200'], labourOnce: labour });
      worst = Math.max(worst, ap.statusCode, rv.statusCode);
      if (labour) expect.soft(h.status === 'approved' ? led['5200'] : labour).toBe(labour);
    }
    r.evidence('C1-C concurrent approve(replace) vs reverse(contra)', out);
    expect(worst).toBeLessThan(500);
  });

  it('C1-D: a hash previewed while the journal was live does not re-lock after the journal is reversed', async () => {
    const id = await r.calculatedRun(7);
    const j1 = String((await r.api.approve(id)).body.data!.journalEntryId);
    await r.api.reopen(id);
    const p = await r.api.preview(id);
    await r.api.reverse(j1);
    const a = await r.api.approveWith(id, p.body.data?.planHash);
    r.evidence('C1-D stale re-lock hash after reversal', { approve: a.statusCode, message: r.msg(a), header: await r.header(id) });
    if (r.hasPlanRoute) expect(a.statusCode).toBe(409);
  });

  it('C1-E: the reversal lands in a LATER period (the month was closed) — the payroll month never carries the run twice', async () => {
    const id = await r.calculatedRun(8);
    const j1 = String((await r.api.approve(id)).body.data!.journalEntryId);
    // month-end close of August, then the pay turns out wrong
    const closed = await r.pool.query(`UPDATE fiscal_periods SET status = 'closed' WHERE company_id = $1 AND start_date <= '2026-08-31' AND end_date >= '2026-08-31' RETURNING period_name`, [r.company]);
    expect(closed.rowCount).toBe(1);
    const steps: unknown[] = [];
    steps.push(['reopen run', (await r.api.reopen(id)).statusCode]);
    const rv = await r.api.reverse(j1);
    steps.push(['reverse j1 (period closed)', rv.statusCode, r.msg(rv), `contra dated ${String(rv.body.data?.entryDate ?? rv.body.data?.entry_date).slice(0, 10)}`]);
    const blocked = await r.api.approve(id);
    steps.push(['approve (period closed)', blocked.statusCode, r.msg(blocked)]);
    await r.pool.query(`UPDATE fiscal_periods SET status = 'open' WHERE company_id = $1 AND status = 'closed'`, [r.company]); // the accountant reopens August to fix it
    const again = await r.api.approve(id);
    steps.push(['approve (period reopened)', again.statusCode, r.msg(again)]);
    const byMonth = (await r.pool.query(
      `SELECT to_char(e.entry_date, 'YYYY-MM') AS month, sum(l.debit - l.credit)::float8 AS labour
         FROM gl_journal_lines l JOIN gl_journal_entries e ON e.id = l.journal_entry_id JOIN gl_accounts a ON a.id = l.gl_account_id
        WHERE e.company_id = $1 AND e.status = 'posted' AND a.account_code = '5200'
          AND (e.description = 'Payroll run 2026-08' OR e.reversal_of_id = $2)
          -- the replacement keeps the run's description whatever its date
        GROUP BY 1 ORDER BY 1`, [r.company, j1])).rows;
    const once = (await r.pool.query(`SELECT sum(debit)::float8 AS d FROM gl_journal_lines WHERE journal_entry_id = $1`, [j1])).rows[0]!.d;
    r.evidence('C1-E reversal in a later period, replacement in the payroll month', { steps, labourByLedgerMonth: byMonth, labourOnce: once, header: await r.header(id) });
    expect(byMonth.find((m) => m.month === '2026-08')?.labour).toBe(once);
    // Round 5 (rule D, pending the owner's ruling): the replacement is dated on the reversal's date,
    // so it posts while August is still closed and the reversal's month nets to nothing.
    expect(blocked.statusCode).toBe(200);
    expect(again.statusCode).toBe(400); // already approved
    expect(byMonth.filter((m) => m.month !== '2026-08').map((m) => m.labour)).toEqual([0]);
  });
});
