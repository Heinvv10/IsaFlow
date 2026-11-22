/**
 * Intercompany P2, round 11: mirroredLinesReachBalanceSheet decides whether the trial balance's and balance sheet's cumulative (inception)
 * windows derive at all. Pinned both ways: with the ordinary mapping (revenue and expense accounts on P&L group accounts) the inception
 * window is never derived; with an odd mapping (a revenue account on an equity group account) it is, and the TB carries the derived line.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';

const calls = vi.hoisted(() => ({ windows: [] as Array<[string, string]> }));
vi.mock('../../../src/modules/accounting/services/reports/mirrorEliminations', async (orig) => {
  const m = await orig<typeof import('../../../src/modules/accounting/services/reports/mirrorEliminations')>();
  return { ...m, getMirroredEliminations: async (g: string, from: string, to: string) => { calls.windows.push([from, to]); return m.getMirroredEliminations(g, from, to); } };
});

import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { getConsolidatedTrialBalance } from '../../../src/modules/accounting/services/reports/consolidatedTrialBalanceService';
import { getConsolidatedBalanceSheet } from '../../../src/modules/accounting/services/reports/consolidatedStatementsService';
import { asService, co, groupAccounts as ga, U } from './mirror.helpers';
import { makeLedger } from './ledger.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const L = makeLedger(pool);
beforeAll(async () => { await L.setup(); await L.monthly(co.B, 2026); }, 60000);
afterAll(L.cleanup, 60000);
beforeEach(async () => { await L.reset(); calls.windows.length = 0; });

const INCEPTION = '1900-01-01';
async function booked() {
  const m = await L.accepted();
  await L.approveBill(m.bill);
  return m;
}
const tb = () => asService(pool, U.ab, co.A, () => getConsolidatedTrialBalance(co.G, '2026-09-01', '2026-09-30'));
const bs = () => asService(pool, U.ab, co.A, () => getConsolidatedBalanceSheet(co.G, '2026-12-31'));

describe('mirroredLinesReachBalanceSheet', () => {
  it('the ordinary mapping: the TB and the BS never derive the inception window (the TB derives its P&L window only)', async () => {
    await booked();
    await tb();
    await bs();
    expect(calls.windows.filter(([from]) => from === INCEPTION)).toEqual([]);
    expect(calls.windows.length).toBe(1);   // the TB's year-to-date P&L window
  });

  it('a revenue account mapped to an EQUITY group account: the inception window is derived and the TB carries the derived line there', async () => {
    await booked();
    const eq = crypto.randomUUID();
    await pool.query(`INSERT INTO group_accounts(id, group_id, account_code, account_name, account_type) VALUES ($1, $2, 'G-EQ2', 'Group odd equity', 'equity')`, [eq, co.G]);
    const aRev = (await pool.query("SELECT id FROM gl_accounts WHERE company_id = $1 AND account_subtype = 'default_revenue'", [co.A])).rows[0].id as string;
    await pool.query('UPDATE group_coa_mappings SET group_account_id = $3 WHERE group_id = $1 AND company_account_id = $2', [co.G, aRev, eq]);
    try {
      const t = await tb();
      expect(calls.windows.some(([from]) => from === INCEPTION)).toBe(true);
      const row = t.groupAccounts.find((a) => a.groupAccountId === eq);
      expect(row?.eliminationDebit).toBe(1000);   // the derived revenue debit, on the (odd) equity account, cumulatively
    } finally {
      await pool.query('UPDATE group_coa_mappings SET group_account_id = $3 WHERE group_id = $1 AND company_account_id = $2', [co.G, aRev, ga.rev]);
      await pool.query('DELETE FROM group_accounts WHERE id = $1', [eq]);
    }
  });
});
