/**
 * Lock order between a company settings save and the writers of fiscal years
 * (the known exception PR #1451 left open in periodCloseGate.ts).
 *
 * A settings save (companyService.updateCompany) always writes
 * companies.financial_year_start, so trg_companies_confirm_fiscal_years fires
 * on every save and UPDATEs the company's assumed fiscal_years rows that start
 * in the declared month: companies, then fiscal_years. A change of year end
 * (apply / undo) wrote fiscal_years and only then UPDATEd companies:
 * fiscal_years, then companies. With the year row written and the save's
 * trigger waiting on it, the change's companies UPDATE closed the cycle: 40P01.
 *
 * A start-month change in Settings (assertFinancialYearStartChange + the
 * rebuild) had the second half of the same problem: its trigger locked a year
 * and only the rebuild then locked the periods, while a close holds its period
 * and then (trg_fiscal_periods_sync_year_status) its year.
 *
 * The canonical order is companies, then periods in (fiscal_year,
 * period_number, id) order, then years. Apply and undo now take the company
 * row FOR NO KEY UPDATE before any fiscal row; a start-month change locks the
 * periods before it writes the company. The interleavings below are forced
 * with a hook on the connection, so each one deadlocked every time before the
 * fix. Assumed years are set by hand: no user flow is known to leave one in
 * the state the trigger acts on (the breaker could not reach it either).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { als } from '@/lib/als';
import { generateFiscalYearForDate } from '@/modules/accounting/services/gl/fiscalYearGenerator';
import { applyYearEndChange } from '@/modules/accounting/services/gl/financialYearEndChangeApply';
import { undoYearEndChange } from '@/modules/accounting/services/gl/financialYearEndChangeUndo';
import { closePeriod, judgePeriodClose } from '@/modules/accounting/services/gl/fiscalPeriodService';
import { updateCompany } from '@/modules/accounting/services/core/companyService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const TODAY = '2026-10-23';
const user = crypto.randomUUID();
const made: string[] = [];
const OK = { reason: 'Align with the holding company year end', cipcFiledConfirmed: true, sarsNotifiedConfirmed: true };
const START_MONTH_WRITE = /^\s*UPDATE companies SET financial_year_start\b/;

beforeAll(async () => {
  await pool.query(`INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'admin', true)`, [user, `${user}@test.local`]);
});

afterAll(async () => {
  try {
    for (const id of made) {
      await pool.query('DELETE FROM audit_log WHERE company_id = $1', [id]);
      await pool.query('UPDATE fiscal_years SET change_id = NULL WHERE company_id = $1', [id]).catch(() => undefined);
      await pool.query('DELETE FROM fiscal_year_end_changes WHERE company_id = $1', [id]).catch(() => undefined);
      await pool.query(`UPDATE fiscal_periods SET status = 'open' WHERE company_id = $1`, [id]).catch(() => undefined);
      await pool.query('DELETE FROM fiscal_periods WHERE company_id = $1', [id]).catch(() => undefined);
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
    client,
    run: <T>(fn: () => Promise<T>) => als.run({ client, companyId, userId: user, claims: {} } as never, fn),
    end: async (how: 'COMMIT' | 'ROLLBACK') => { try { await client.query(how); } finally { client.release(); } },
  };
}
type Request = Awaited<ReturnType<typeof request>>;

const once = async <T>(companyId: string, fn: () => Promise<T>) => {
  const r = await request(companyId);
  try { const out = await r.run(fn); await r.end('COMMIT'); return out; } catch (e) { await r.end('ROLLBACK'); throw e; }
};

/** Runs `fn` in `r` and ends it: COMMIT on success, ROLLBACK on error. Resolves to 'ok' or the error. */
async function settle(r: Request, fn: () => Promise<unknown>): Promise<unknown> {
  const out = await r.run(fn).then(() => 'ok', (e: unknown) => e);
  await r.end(out === 'ok' ? 'COMMIT' : 'ROLLBACK');
  return out;
}

/** The first statement on `client` matching `re` waits for `before()` first. Returns the restore. */
function pauseBefore(client: PoolClient, re: RegExp, before: () => Promise<void>): () => void {
  const query = client.query.bind(client) as (...a: unknown[]) => Promise<unknown>;
  let fired = false;
  (client as unknown as { query: unknown }).query = (...q: unknown[]) => {
    if (!fired && typeof q[0] === 'string' && re.test(q[0])) {
      fired = true;
      return before().then(() => query(...q));
    }
    return query(...q);
  };
  return () => { (client as unknown as { query: unknown }).query = query; };
}

async function someoneWaitsOnALock(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()");
    if (rows[0].n > 0) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('nobody waited on a lock');
}

const codeOf = (e: unknown) => (e as { code?: string } | null)?.code;
const describeOutcome = (e: unknown) => (e === 'ok' ? 'ok' : `${codeOf(e) ?? ''} ${String(e)}`);
/** 40P01, also when a caller wrapped it (rebuildOrRollBack re-throws with the cause in the message). */
const deadlocked = (e: unknown) => codeOf(e) === '40P01' || /deadlock detected/.test(String(e));

async function expectCompany(c: string, want: { name: string; month: number }): Promise<void> {
  const { rows: [co] } = await pool.query('SELECT name, financial_year_start AS month FROM companies WHERE id = $1', [c]);
  expect(co).toEqual(want);
}

async function newCompany(name: string, startMonth: number): Promise<string> {
  const c = crypto.randomUUID();
  made.push(c);
  await pool.query('INSERT INTO companies (id, name, financial_year_start) VALUES ($1, $2, $3)', [c, name, startMonth]);
  return c;
}

/**
 * The year-end change `change` runs on one connection; just before its
 * companies UPDATE (after it has written fiscal_years) a settings save of
 * `month`, loaded before the change, starts on another, and the change goes on
 * once the save waits. The save then finds a month it did not load: 409
 * (CompanySettingsStaleError) and nothing written, never its stale month over
 * the change's (the lost update Hein ruled on for PR #1551).
 */
async function changeAgainstSettingsSave(c: string, month: number, change: () => Promise<unknown>) {
  const a = await request(c);
  let saved: Promise<unknown> | null = null;
  const restore = pauseBefore(a.client, START_MONTH_WRITE, async () => {
    const b = await request(c);
    saved = settle(b, () => updateCompany(c, { name: 'STALE SAVE', financialYearStart: month, loadedFinancialYearStart: month }));
    await someoneWaitsOnALock();
  });
  const changed = await settle(a, async () => { try { return await change(); } finally { restore(); } });
  const save = await (saved ?? Promise.resolve('the settings save never started'));
  return { changed, save };
}

describe('company settings save vs a change of year end', () => {
  it('apply: the save waits for the change, then refuses its stale month (409); nobody gets 40P01', async () => {
    const c = await newCompany('LOCK ORDER apply co', 1);
    for (const d of ['2026-03-01', '2027-03-01']) await once(c, () => generateFiscalYearForDate(c, d));
    // FY2027 (Jan-Dec 2027) assumed: the save's trigger acts on it, and the apply deletes it.
    await pool.query('UPDATE fiscal_years SET assumed_start = true WHERE company_id = $1 AND fiscal_year = 2027', [c]);

    const { changed, save } = await changeAgainstSettingsSave(c, 1, () => applyYearEndChange(
      c, user, { newYearEndMonth: 2, expectedEndDate: '2027-02-28', ...OK }, TODAY));

    expect(deadlocked(changed), describeOutcome(changed)).toBe(false);
    expect(deadlocked(save), describeOutcome(save)).toBe(false);
    expect(describeOutcome(changed)).toBe('ok');
    expect((save as Error).name, describeOutcome(save)).toBe('CompanySettingsStaleError');
    const { rows } = await pool.query(
      `SELECT to_end_date::text AS e FROM fiscal_year_end_changes WHERE company_id = $1 AND reversed_at IS NULL`, [c]);
    expect(rows.map((r) => r.e)).toEqual(['2027-02-28']);
    await expectCompany(c, { name: 'LOCK ORDER apply co', month: 3 });  // the change's month; the stale save wrote nothing
  }, 60000);

  it('undo: the save waits for the undo, then refuses its stale month (409); nobody gets 40P01', async () => {
    const c = await newCompany('LOCK ORDER undo co', 1);
    for (const d of ['2026-03-01', '2027-03-01']) await once(c, () => generateFiscalYearForDate(c, d));
    await once(c, () => applyYearEndChange(c, user, { newYearEndMonth: 2, expectedEndDate: '2027-02-28', ...OK }, TODAY));
    // The years after the transition year start in March, the month now declared; the undo deletes them.
    await pool.query(`UPDATE fiscal_years SET assumed_start = true WHERE company_id = $1 AND start_date > '2026-01-01'`, [c]);

    const { changed, save } = await changeAgainstSettingsSave(c, 3, () => undoYearEndChange(c, user, 'filed in error'));

    expect(deadlocked(changed), describeOutcome(changed)).toBe(false);
    expect(deadlocked(save), describeOutcome(save)).toBe(false);
    expect(describeOutcome(changed)).toBe('ok');
    expect((save as Error).name, describeOutcome(save)).toBe('CompanySettingsStaleError');
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM fiscal_year_end_changes WHERE company_id = $1 AND reversed_at IS NOT NULL`, [c]);
    expect(rows[0].n).toBe(1);
    await expectCompany(c, { name: 'LOCK ORDER undo co', month: 1 });  // the undo's month; the stale save wrote nothing
  }, 60000);
});

describe('start-month change in Settings vs a period close', () => {
  it('the change waits for the close and then refuses (409); nobody gets 40P01', async () => {
    // A March year, marked assumed; then January declared, which confirms only January years.
    const c = await newCompany('LOCK ORDER start-month co', 3);
    await once(c, () => generateFiscalYearForDate(c, '2026-03-01'));
    await pool.query('UPDATE fiscal_years SET assumed_start = true WHERE company_id = $1', [c]);
    await pool.query('UPDATE companies SET financial_year_start = 1 WHERE id = $1', [c]);
    const { rows: [mar] } = await pool.query(
      `SELECT fp.id FROM fiscal_periods fp JOIN fiscal_years fy ON fy.id = fp.fiscal_year_id
        WHERE fp.company_id = $1 AND fp.start_date = '2026-03-01' AND fy.assumed_start`, [c]);
    expect(mar, 'an assumed March year holding March 2026').toBeTruthy();

    const close = await request(c);
    await close.run(() => judgePeriodClose(c, mar.id));          // the close holds March 2026's row
    const save = await request(c);
    const saved = settle(save, () => updateCompany(c, { financialYearStart: 3, loadedFinancialYearStart: 1 }));
    await someoneWaitsOnALock();                                   // the change is queued behind the close
    const closed = await settle(close, () => closePeriod(c, mar.id, user));
    const changed = await saved;

    expect(deadlocked(closed), describeOutcome(closed)).toBe(false);
    expect(deadlocked(changed), describeOutcome(changed)).toBe(false);
    expect(describeOutcome(closed)).toBe('ok');
    expect((changed as Error).name, describeOutcome(changed)).toBe('FiscalPeriodsInUseError');
    const { rows: [co] } = await pool.query('SELECT financial_year_start AS m FROM companies WHERE id = $1', [c]);
    expect(co.m).toBe(1);
  }, 60000);
});
