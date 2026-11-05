/**
 * postPayrollRunJournal's final stamp lands only on a run with no journal. The header lock makes that a miss under
 * a request transaction; for a caller whose lock lapsed (a script, or a plan built before the lock) the
 * `journal_entry_id IS NULL` condition is the only guard. Reached here by handing the poster a header read that
 * shows no link (the lock mocked to lapse) for a run that already carries one: the stamp must match no row, the
 * poster must throw, and the run's link must be the first journal's. Disposable fixture DB only.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { withAlsTransaction } from '@/lib/alsTransaction';

const lapse = vi.hoisted(() => ({ on: false }));
vi.mock('@/modules/accounting/services/payroll/payrollRunLock', async (orig) => {
  const actual = await orig<typeof import('@/modules/accounting/services/payroll/payrollRunLock')>();
  return {
    ...actual,
    lockPayrollRunHeader: async (...a: Parameters<typeof actual.lockPayrollRunHeader>) =>
      lapse.on ? { id: a[0], journal_entry_id: null } : actual.lockPayrollRunHeader(...a),
  };
});

import { buildPayrollJournalPlan } from '@/modules/accounting/services/payroll/payrollJournalBuilder';
import { postPayrollRunJournal } from '@/modules/accounting/services/payroll/payrollJournalPostingService';
import { rig } from './brkr.helpers';

let r: Awaited<ReturnType<typeof rig>>;
beforeAll(async () => { r = await rig('poststamp'); await r.setup(); await r.employee(20000); });
afterAll(async () => { await r.teardown(); });

const inTx = <T>(fn: () => Promise<T>) => withAlsTransaction({ companyId: r.company, userId: r.admin }, fn);
const journalCount = async (): Promise<number> => (await r.pool.query(
  "SELECT count(*)::int n FROM gl_journal_entries WHERE company_id = $1 AND source = 'auto_payroll'", [r.company])).rows[0].n;

it('does not overwrite a run\'s link, and posts no second journal, when the lock did not show it', async () => {
  const run = await r.calculatedRun(7);
  await r.pool.query(
    "UPDATE payroll_run_headers SET status = 'approved', approved_by = $2, approved_at = clock_timestamp(), lines_confirmed_at = clock_timestamp() WHERE id = $1",
    [run, r.admin]);
  const first = await inTx(() => postPayrollRunJournal(r.company, run, r.admin));
  expect((await r.header(run)).journal_entry_id).toBe(first);

  lapse.on = true;
  try {
    const stale = await buildPayrollJournalPlan(r.company, run);
    await expect(inTx(() => postPayrollRunJournal(r.company, run, r.admin, {
      plan: { ...stale!, alreadyPostedJournalId: null, blockers: [] },
    }))).rejects.toThrow(/already carries a journal/);
  } finally { lapse.on = false; }

  expect((await r.header(run)).journal_entry_id).toBe(first);
  expect(await journalCount()).toBe(1); // the request transaction rolled the second journal back
});
