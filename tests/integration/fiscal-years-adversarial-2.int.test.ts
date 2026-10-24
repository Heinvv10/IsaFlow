/**
 * Round-2 adversarial repros for PR #807: attacks on the FIXES at 1077eb862.
 * Each test asserts the invariant; red = finding. Rolled back. Synthetic data.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { als } from '@/lib/als';
import { getFiscalRange, getFiscalRangeWithPrior } from '@/modules/accounting/services/afs/afsFiscalPeriod';
import { ensureFiscalPeriodForDate } from '@/modules/accounting/services/gl/fiscalPeriodAutoCreate';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
afterAll(async () => { await pool.end(); });

async function inRolledBackTx(fn: (c: PoolClient) => Promise<void>) {
  const c = await pool.connect();
  try { await c.query('BEGIN'); await fn(c); } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    c.release();
  }
}
async function attempt(c: PoolClient, fn: () => Promise<unknown>) {
  await c.query('SAVEPOINT attack');
  try { await fn(); await c.query('RELEASE SAVEPOINT attack'); return null; } catch (e) {
    await c.query('ROLLBACK TO SAVEPOINT attack');
    return e as { code?: string; message: string };
  }
}
const inAls = <T>(c: PoolClient, co: string, fn: () => Promise<T>) =>
  als.run({ client: c, companyId: co, userId: crypto.randomUUID(), claims: {} } as never, fn);
async function company(c: PoolClient, fyStart: number | null = 3) {
  const id = crypto.randomUUID();
  await c.query(`INSERT INTO companies (id, name, financial_year_start) VALUES ($1, 'BRK807B', $2)`, [id, fyStart]);
  return id;
}
async function year(c: PoolClient, co: string, date: string, status = 'open') {
  const y = (await c.query('SELECT public.fiscal_year_ensure($1, $2) AS id', [co, date])).rows[0].id as string;
  await c.query('SELECT public.fiscal_periods_generate($1)', [y]);
  if (status !== 'open') await c.query('UPDATE fiscal_periods SET status = $2 WHERE fiscal_year_id = $1', [y, status]);
  return y;
}
async function asAppUser(c: PoolClient, userId: string, companyId: string) {
  await c.query('SET LOCAL ROLE app_user');
  await c.query(`SELECT set_config('request.jwt.claims', $1, true), set_config('app.current_company_id', $2, true)`,
    [JSON.stringify({ sub: userId }), companyId]);
}
async function postedJournal(c: PoolClient, co: string, date: string) {
  const user = crypto.randomUUID();
  await c.query(`INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'admin', true)`, [user, `${user}@t.local`]);
  const [a1, a2] = [crypto.randomUUID(), crypto.randomUUID()];
  await c.query(
    `INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, normal_balance, level, is_active)
     VALUES ($1, $3, $4, 'bank', 'asset', 'debit', 3, true), ($2, $3, $5, 'sales', 'revenue', 'credit', 3, true)`,
    [a1, a2, co, `B-${a1.slice(0, 6)}`, `S-${a2.slice(0, 6)}`]);
  const je = (await c.query(
    `INSERT INTO gl_journal_entries (company_id, entry_date, created_by, description, status)
     VALUES ($1, $2, $3, 'brk807b', 'draft') RETURNING id, fiscal_period_id`, [co, date, user])).rows[0];
  await c.query(`INSERT INTO gl_journal_lines (journal_entry_id, gl_account_id, debit, credit, company_id)
                 VALUES ($1, $2, 100, 0, $4), ($1, $3, 0, 100, $4)`, [je.id, a1, a2, co]);
  await c.query(`UPDATE gl_journal_entries SET status = 'posted' WHERE id = $1`, [je.id]);
  return je as { id: string; fiscal_period_id: string };
}
/** The readers suite's own shape: a January year end changed to February via a 14-month transition year. */
async function changedYearEnd(c: PoolClient) {
  const co = await company(c, 3);
  const fy25 = (await c.query(`INSERT INTO fiscal_years (company_id, fiscal_year, start_date, end_date)
    VALUES ($1, 2025, '2025-01-01', '2025-12-31') RETURNING id`, [co])).rows[0].id;
  const fy26 = (await c.query(`INSERT INTO fiscal_years (company_id, fiscal_year, start_date, end_date, kind)
    VALUES ($1, 2026, '2026-01-01', '2027-02-28', 'transition') RETURNING id`, [co])).rows[0].id;
  for (const id of [fy25, fy26]) await c.query('SELECT public.fiscal_periods_generate($1)', [id]);
  return co;
}

describe('R2-1 — template fix (chain only from declared-month years) breaks history before a changed year end', () => {
  it('a date before the first (pre-change) year resolves to the year before it', async () => {
    await inRolledBackTx(async (c) => {
      const co = await changedYearEnd(c);
      const e = await attempt(c, () => c.query(`SELECT * FROM public.fiscal_year_for_date($1, '2024-11-15')`, [co]));
      const got = e ? e.message : (await c.query(`SELECT start_date::text s, end_date::text e FROM public.fiscal_year_for_date($1, '2024-11-15')`, [co])).rows[0];
      expect(got).toEqual({ s: '2024-01-01', e: '2024-12-31' });
    });
  });
  it('the AFS comparative for the first year resolves', async () => {
    await inRolledBackTx(async (c) => {
      const co = await changedYearEnd(c);
      const r = await inAls(c, co, () => getFiscalRangeWithPrior(co, 2025, true)).catch((e: Error) => e.message);
      expect(r).toEqual({ current: { start: '2025-01-01', end: '2025-12-31' }, prior: { start: '2024-01-01', end: '2024-12-31' } });
    });
  });
  it('a back-dated posting before the first year gets a period, never a silent NULL', async () => {
    await inRolledBackTx(async (c) => {
      const co = await changedYearEnd(c);
      const id = await inAls(c, co, () => ensureFiscalPeriodForDate(co, '2024-11-15')).catch((e: Error) => `threw: ${e.message}`);
      expect(id === null ? 'NULL (journal would post with no period)' : 'period or refusal').toBe('period or refusal');
    });
  });
});

describe('R2-2 — journal stranding check ignores a period moved to ANOTHER company', () => {
  it("a member of two companies cannot move A's period (holding A's journal) to B", async () => {
    await inRolledBackTx(async (c) => {
      const A = await company(c), B = await company(c);
      const u = `brk807b-${crypto.randomUUID()}`;
      await c.query(`INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $3, 'owner'), ($2, $3, 'owner')`, [A, B, u]);
      await year(c, A, '2025-06-01');
      const bYear = await year(c, B, '2025-06-01');
      await c.query(`DELETE FROM fiscal_periods WHERE company_id = $1 AND start_date = '2025-06-01'`, [B]); // an open gap in B
      const je = await postedJournal(c, A, '2025-06-20');
      await asAppUser(c, u, B); // working in B
      const e = await attempt(c, async () => {
        await c.query(`UPDATE fiscal_periods SET company_id = $2, fiscal_year_id = $3 WHERE id = $1`, [je.fiscal_period_id, B, bYear]);
        await c.query('SET CONSTRAINTS ALL IMMEDIATE');
      });
      await c.query('RESET ROLE');
      const cross = (await c.query(
        `SELECT count(*)::int n FROM gl_journal_entries je JOIN fiscal_periods fp ON fp.id = je.fiscal_period_id
          WHERE je.company_id = $1 AND fp.company_id <> je.company_id`, [A])).rows[0].n;
      expect({ refused: e !== null, crossTenantJournals: cross }).toEqual({ refused: true, crossTenantJournals: 0 });
    });
  });
});

describe('R2-3 — posted journal moves into a locked period via unpost / re-date / repost', () => {
  it('a locked period\'s balance cache never changes', async () => {
    await inRolledBackTx(async (c) => {
      const A = await company(c);
      await year(c, A, '2025-06-01');
      await c.query(`UPDATE fiscal_periods SET status = 'locked' WHERE company_id = $1 AND start_date = '2025-07-01'`, [A]);
      const je = await postedJournal(c, A, '2025-06-20');
      // As a non-superuser role (a superuser is the sanctioned operator path).
      await c.query('SET LOCAL ROLE platform_admin');
      const e = await attempt(c, async () => {
        await c.query(`UPDATE gl_journal_entries SET status = 'draft' WHERE id = $1`, [je.id]);
        await c.query(`UPDATE gl_journal_entries SET entry_date = '2025-07-10' WHERE id = $1`, [je.id]);
        await c.query(`UPDATE gl_journal_entries SET status = 'posted' WHERE id = $1`, [je.id]);
      });
      await c.query('RESET ROLE');
      const locked = (await c.query(
        `SELECT COALESCE(sum(b.debit_total), 0)::float d FROM gl_account_balances b JOIN fiscal_periods fp ON fp.id = b.fiscal_period_id
          WHERE fp.company_id = $1 AND fp.status = 'locked'`, [A])).rows[0].d;
      expect({ refused: e !== null, lockedDebits: locked }).toEqual({ refused: true, lockedDebits: 0 });
    });
  });
});

describe('R2-4 — the delete/unlock guard is allow-by-default for roles outside app_user', () => {
  it('platform_admin (the admin portal role) cannot delete or unlock a locked period', async () => {
    await inRolledBackTx(async (c) => {
      const A = await company(c);
      await year(c, A, '2025-06-01', 'locked');
      await c.query('SET LOCAL ROLE platform_admin');
      const unlock = await attempt(c, () => c.query(`UPDATE fiscal_periods SET status = 'open' WHERE company_id = $1 AND start_date = '2025-06-01'`, [A]));
      const del = await attempt(c, () => c.query(`DELETE FROM fiscal_periods WHERE company_id = $1 AND start_date = '2025-07-01'`, [A]));
      await c.query('RESET ROLE');
      expect({ unlockRefused: unlock !== null, deleteRefused: del !== null }).toEqual({ unlockRefused: true, deleteRefused: true });
    });
  });
});

describe('R2-5 — read fallback in the link path stores an assumed-March year the AFS then trusts', () => {
  it('AFS refuses a company with no usable financial_year_start even once its periods exist', async () => {
    await inRolledBackTx(async (c) => {
      const co = await company(c, null);
      await c.query(`INSERT INTO fiscal_periods (company_id, period_name, period_number, fiscal_year, start_date, end_date)
                     VALUES ($1, 'Jan 2026', 1, 2026, '2026-01-01', '2026-01-31')`, [co]);
      const r = await inAls(c, co, () => getFiscalRange(co, 2026)).catch((e: Error) => e.name);
      expect(r).toBe('StartMonthAssumedError');
    });
  });
});

describe('R3-1 — a registry raise still becomes a silent NULL period in ensureFiscalPeriodForDate', () => {
  it('a posting the registry cannot place is refused, not given fiscal_period_id NULL', async () => {
    await inRolledBackTx(async (c) => {
      const co = await company(c, 3);
      // A whole-year period labelled by its START+1 (step 3 of fiscal_year_link_period stores it as FY2026 = 2025).
      await c.query(`INSERT INTO fiscal_periods (company_id, period_name, period_number, fiscal_year, start_date, end_date)
                     VALUES ($1, 'Year', 1, 2026, '2025-01-01', '2025-12-31')`, [co]);
      await year(c, co, '2026-06-01'); // FY2027 Mar 2026 - Feb 2027
      const tmpl = await attempt(c, () => c.query(`SELECT * FROM public.fiscal_year_for_date($1, '2026-01-15')`, [co]));
      const id = await inAls(c, co, () => ensureFiscalPeriodForDate(co, '2026-01-15')).catch((e: Error) => `threw: ${e.message}`);
      expect({ registry: tmpl?.message ?? 'ok', ensure: id === null ? 'NULL' : 'period or refusal' })
        .toEqual({ registry: expect.any(String), ensure: 'period or refusal' });
    });
  });
});

describe('R3-2 — template stability: a read before and after storing the next year agree', () => {
  it('REPRO 7 shape: Jan 2026 resolves to the same year whether FY2027 is stored or not', async () => {
    await inRolledBackTx(async (c) => {
      const co = await company(c, 3);
      await c.query(`INSERT INTO fiscal_periods (company_id, period_name, period_number, fiscal_year, start_date, end_date)
                     VALUES ($1, 'Year', 1, 2025, '2025-01-01', '2025-12-31')`, [co]);
      const q = async () => (await c.query(`SELECT fiscal_year, start_date::text s, end_date::text e FROM public.fiscal_year_for_date($1, '2026-01-15')`, [co])).rows[0];
      const before = await q();
      await year(c, co, '2026-06-01');
      const after = await q();
      const fy27 = (await c.query(`SELECT start_date::text s FROM fiscal_years WHERE company_id = $1 AND fiscal_year = 2027`, [co])).rows[0];
      expect({ before, after, fy27 }).toEqual({ before: after, after: before, fy27: { s: '2026-03-01' } });
    });
  });
});
