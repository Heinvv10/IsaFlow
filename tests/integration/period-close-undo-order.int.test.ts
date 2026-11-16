/**
 * Undo of a change of year end vs a period close, on two connections (review
 * round 2 of PR #1451, arch A / breaker N1).
 *
 * The close holds a period row and its status UPDATE fires
 * trg_fiscal_periods_sync_year_status, which takes the year row FOR UPDATE:
 * period, then year. The undo wrote fiscal_years first and then UPDATEd
 * fiscal_periods: year, then period. With the close judged (period row held)
 * and the undo started, the close's UPDATE and the undo's period UPDATE waited
 * on each other: 40P01. The undo now locks the periods it may touch in
 * (fiscal_year, period_number, id) order before it writes a year, so the two
 * serialise: the close finishes, then the undo runs (and here refuses, because
 * a period it would move is now closed).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { als } from '@/lib/als';
import { generateFiscalYearForDate } from '@/modules/accounting/services/gl/fiscalYearGenerator';
import { applyYearEndChange } from '@/modules/accounting/services/gl/financialYearEndChangeApply';
import { undoYearEndChange } from '@/modules/accounting/services/gl/financialYearEndChangeUndo';
import { closePeriod, judgePeriodClose } from '@/modules/accounting/services/gl/fiscalPeriodService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const TODAY = '2026-10-23';
const user = crypto.randomUUID();
const made: string[] = [];
const OK = { reason: 'Align with the holding company year end', cipcFiledConfirmed: true, sarsNotifiedConfirmed: true };

afterAll(async () => {
  try {
    for (const id of made) {
      await pool.query('DELETE FROM audit_log WHERE company_id = $1', [id]);
      await pool.query('UPDATE fiscal_years SET change_id = NULL WHERE company_id = $1', [id]).catch(() => undefined);
      await pool.query('DELETE FROM fiscal_year_end_changes WHERE company_id = $1', [id]).catch(() => undefined);
      await pool.query('DELETE FROM fiscal_periods WHERE company_id = $1', [id]);
      await pool.query('DELETE FROM fiscal_years WHERE company_id = $1', [id]).catch(() => undefined);
      await pool.query('DELETE FROM companies WHERE id = $1', [id]).catch(() => undefined);
    }
    await pool.query('DELETE FROM users WHERE id = $1', [user]);
  } finally { await pool.end(); }
}, 60000);

/** A request transaction the test holds open. */
async function request(companyId: string) {
  const client: PoolClient = await pool.connect();
  await client.query('BEGIN');
  return {
    run: <T>(fn: () => Promise<T>) => als.run({ client, companyId, userId: user, claims: {} } as never, fn),
    end: async (how: 'COMMIT' | 'ROLLBACK') => { try { await client.query(how); } finally { client.release(); } },
  };
}
const once = async <T>(companyId: string, fn: () => Promise<T>) => {
  const r = await request(companyId);
  try { const out = await r.run(fn); await r.end('COMMIT'); return out; } catch (e) { await r.end('ROLLBACK'); throw e; }
};

async function someoneWaitsOnALock(): Promise<void> {
  for (let i = 0; i < 80; i++) {
    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()");
    if (rows[0].n > 0) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('nobody waited on a lock');
}

const codeOf = (e: unknown) => (e as { code?: string } | null)?.code;

describe('undo of a change of year end vs a period close', () => {
  it('serialise: the close finishes, the undo then runs (here refused), and nobody gets 40P01', async () => {
    await pool.query(`INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'admin', true)`, [user, `${user}@test.local`]);
    const c = crypto.randomUUID();
    made.push(c);
    await pool.query(`INSERT INTO companies (id, name, financial_year_start) VALUES ($1, 'UNDO co', 1)`, [c]);
    for (const d of ['2026-03-01', '2027-03-01']) await once(c, () => generateFiscalYearForDate(c, d));
    // Dec -> Feb: FY2026 becomes the 14-month transition year Jan 2026 - Feb 2027.
    await once(c, () => applyYearEndChange(c, user, { newYearEndMonth: 2, expectedEndDate: '2027-02-28', ...OK }, TODAY));
    const periods = (await pool.query(
      `SELECT id, start_date::text s FROM fiscal_periods WHERE company_id = $1 ORDER BY start_date`, [c])).rows as Array<{ id: string; s: string }>;
    const jan27 = periods.find((p) => p.s === '2027-01-01')!.id;
    // Everything before January 2027 is closed (they are at or before the undo's boundary, so the undo may run).
    await pool.query(`UPDATE fiscal_periods SET status = 'closed' WHERE company_id = $1 AND start_date < '2027-01-01'`, [c]);

    const close = await request(c);
    await close.run(() => judgePeriodClose(c, jan27));           // the close holds January 2027's row
    const undo = await request(c);
    const undone = undo.run(() => undoYearEndChange(c, user, 'filed in error'));
    await someoneWaitsOnALock();                                  // the undo is queued behind the close
    let closeError: unknown = null;
    await close.run(() => closePeriod(c, jan27, user)).catch((e) => { closeError = e; });
    await close.end(closeError ? 'ROLLBACK' : 'COMMIT');
    const undoOutcome = await undone.then(() => 'undone', (e) => e);
    await undo.end(undoOutcome === 'undone' ? 'COMMIT' : 'ROLLBACK');

    expect(codeOf(closeError), String(closeError)).not.toBe('40P01');
    expect(closeError).toBeNull();
    expect(codeOf(undoOutcome), String(undoOutcome)).not.toBe('40P01');
    expect(String((undoOutcome as Error).name ?? undoOutcome)).toBe('YearEndChangeRefusedError');
    const { rows: [jan] } = await pool.query('SELECT status FROM fiscal_periods WHERE id = $1', [jan27]);
    expect(jan.status).toBe('closed');
  }, 60000);
});
