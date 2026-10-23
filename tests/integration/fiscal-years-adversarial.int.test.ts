/**
 * Adversarial repros from the PR #807 ledger review (fiscal_years 940/941/942).
 * Each test asserts an invariant the migrations claim; every one was red before
 * its fix. Every test runs in one
 * transaction that is rolled back. All data synthetic.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { als } from '@/lib/als';
import { registryYearStart } from '@/modules/accounting/services/audit/snapshotRows';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
afterAll(async () => { await pool.end(); });

async function inRolledBackTx(fn: (c: PoolClient) => Promise<void>) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await fn(c);
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    c.release();
  }
}
/** Run an attack inside a savepoint: a refusal is returned, and the transaction stays usable. */
async function attempt(c: PoolClient, fn: () => Promise<unknown>): Promise<{ code?: string; message: string } | null> {
  await c.query('SAVEPOINT attack');
  try { await fn(); await c.query('RELEASE SAVEPOINT attack'); return null; } catch (e) {
    await c.query('ROLLBACK TO SAVEPOINT attack');
    return e as { code?: string; message: string };
  }
}

async function company(c: PoolClient, fyStart: number | null = 3): Promise<string> {
  const id = crypto.randomUUID();
  await c.query(`INSERT INTO companies (id, name, financial_year_start) VALUES ($1, 'BRK807', $2)`, [id, fyStart]);
  return id;
}
/** One fully generated March year holding `date`, every period set to `status`. */
async function year(c: PoolClient, co: string, date: string, status = 'open'): Promise<string> {
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

describe('REPRO 1 — tenant isolation: app_user links its period to ANOTHER company\'s (closed) fiscal year', () => {
  it('refuses a period whose fiscal_year_id belongs to another company', async () => {
    await inRolledBackTx(async (c) => {
      const A = await company(c), B = await company(c);
      const u = `brk807-${crypto.randomUUID()}`;
      await c.query(`INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $3, 'owner'), ($2, $3, 'owner')`, [A, B, u]);
      const bYear = await year(c, B, '2025-06-01', 'closed');
      expect((await c.query('SELECT status FROM fiscal_years WHERE id = $1', [bYear])).rows[0].status).toBe('closed');

      await asAppUser(c, u, A); // working in A
      const e = await attempt(c, async () => {
        await c.query(
          `INSERT INTO fiscal_periods (company_id, fiscal_year_id, period_name, period_number, fiscal_year, start_date, end_date)
           VALUES ($1, $2, 'A period in B year', 1, 2026, '2025-06-01', '2025-06-30')`, [A, bYear]);
        await c.query('SET CONSTRAINTS ALL IMMEDIATE');
      });
      await c.query('RESET ROLE');
      const linked = (await c.query(
        `SELECT fy.company_id = $2 AS in_b, fy.status, public.fiscal_year_derived_status(fy.id) AS derived
           FROM fiscal_periods fp JOIN fiscal_years fy ON fy.id = fp.fiscal_year_id
          WHERE fp.company_id = $1 AND fp.period_name = 'A period in B year'`, [A, B])).rows;
      // Claimed: "every period lies inside its year, of the same company" and "nothing is added to a closed year".
      expect({ refused: e !== null, linked }).toEqual({ refused: true, linked: [] });
    });
  });

  it('...and a member of both can then relabel B\'s closed year', async () => {
    await inRolledBackTx(async (c) => {
      const A = await company(c), B = await company(c);
      const u = `brk807-${crypto.randomUUID()}`;
      await c.query(`INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $3, 'owner'), ($2, $3, 'owner')`, [A, B, u]);
      const bYear = await year(c, B, '2025-06-01', 'closed');
      await asAppUser(c, u, A);
      await attempt(c, () => c.query(
        `INSERT INTO fiscal_periods (company_id, fiscal_year_id, period_name, period_number, fiscal_year, start_date, end_date, status)
         VALUES ($1, $2, 'A open in B', 1, 2026, '2025-06-01', '2025-06-30', 'open')`, [A, bYear]));
      await c.query(`SELECT set_config('app.current_company_id', $1, true)`, [B]); // switch to B
      await c.query('UPDATE fiscal_years SET updated_at = now() WHERE id = $1', [bYear]); // re-derives status
      const relabel = await attempt(c, () => c.query('UPDATE fiscal_years SET fiscal_year = 2099 WHERE id = $1', [bYear]));
      await c.query('RESET ROLE');
      const after = (await c.query('SELECT fiscal_year, status FROM fiscal_years WHERE id = $1', [bYear])).rows[0];
      // Claimed: "a closed or locked year cannot be re-dated or relabelled".
      expect({ relabelRefused: relabel !== null, after }).toEqual({ relabelRefused: true, after: { fiscal_year: 2026, status: 'closed' } });
    });
  });
});

describe('REPRO 2 — deleting an empty closed period reopens a closed year to new periods', () => {
  it('a closed year cannot get a new open period by delete-then-insert (app_user)', async () => {
    await inRolledBackTx(async (c) => {
      const A = await company(c);
      const u = `brk807-${crypto.randomUUID()}`;
      await c.query(`INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'owner')`, [A, u]);
      const y = await year(c, A, '2025-06-01', 'locked');
      await asAppUser(c, u, A);
      const del = await attempt(c, () => c.query(`DELETE FROM fiscal_periods WHERE company_id = $1 AND start_date = '2025-06-01'`, [A]));
      const ins = await attempt(c, () => c.query(
        `INSERT INTO fiscal_periods (company_id, period_name, period_number, fiscal_year, start_date, end_date)
         VALUES ($1, 'June again', 4, 2026, '2025-06-01', '2025-06-30')`, [A]));
      await c.query('RESET ROLE');
      const yr = (await c.query('SELECT status FROM fiscal_years WHERE id = $1', [y])).rows[0].status;
      // Claimed: "nothing is added to a closed or locked year".
      expect({ deleteRefused: del !== null, insertRefused: ins !== null, yearStatus: yr })
        .toEqual({ deleteRefused: true, insertRefused: true, yearStatus: 'locked' });
    });
  });
});

describe("REPRO 3 — 941's 'checked cache': re-dating an OPEN period strands its journals outside it", () => {
  it("a journal's fiscal_period_id always holds its entry_date", async () => {
    await inRolledBackTx(async (c) => {
      const A = await company(c);
      const user = crypto.randomUUID();
      await c.query(`INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'admin', true)`, [user, `${user}@t.local`]);
      await year(c, A, '2025-06-01');
      const je = (await c.query(
        `INSERT INTO gl_journal_entries (company_id, entry_date, created_by, description, status)
         VALUES ($1, '2025-06-20', $2, 'brk807', 'draft') RETURNING id, fiscal_period_id`, [A, user])).rows[0];
      const upd = await attempt(c, async () => {
        await c.query(`UPDATE fiscal_periods SET end_date = '2025-06-15' WHERE id = $1`, [je.fiscal_period_id]);
        await c.query('SET CONSTRAINTS ALL IMMEDIATE');
      });
      const stranded = (await c.query(
        `SELECT count(*)::int AS n FROM gl_journal_entries je JOIN fiscal_periods fp ON fp.id = je.fiscal_period_id
          WHERE je.company_id = $1 AND je.entry_date NOT BETWEEN fp.start_date AND fp.end_date`, [A])).rows[0].n;
      expect({ periodMoveRefused: upd !== null, stranded }).toEqual({ periodMoveRefused: true, stranded: 0 });
    });
  });
});

// Intended change (decided 2026-10-23, gate G1/G3: the DECLARED year is the year):
// the audit snapshot's year start was the period LABEL group's (January on a
// company declaring March); it is now the stored year's, the same March the TB,
// AFS and year-end close use. Sealed snapshots compare on their own stored fy_start.
describe('audit snapshot / check-run year start follows the declared (stored) year', () => {
  it('a prod-shaped company (declares March, January-December labels) cuts at 1 March, as its TB does', async () => {
    await inRolledBackTx(async (c) => {
      // Prod shape (budgetVariance.ts): declares March, periods labelled January-December.
      const A = await company(c);
      for (let m = 1; m <= 12; m++) {
        const s = `2026-${String(m).padStart(2, '0')}-01`;
        await c.query(
          `INSERT INTO fiscal_periods (company_id, period_name, period_number, fiscal_year, start_date, end_date)
           VALUES ($1, $2, $3, 2026, $4::date, ($4::date + interval '1 month')::date - 1)`, [A, `M${m}`, m, s]);
      }
      // Pre-PR snapshotRows.fiscalYearStart, verbatim (git show 2c59ed96f:src/modules/accounting/services/audit/snapshotRows.ts).
      const before = (await c.query(
        `SELECT COALESCE(
           (SELECT min(fy.start_date) FROM fiscal_periods p
              JOIN fiscal_periods fy ON fy.company_id = p.company_id AND fy.fiscal_year = p.fiscal_year
             WHERE p.company_id = $1::UUID AND $2::DATE BETWEEN p.start_date AND p.end_date),
           date_trunc('year', $2::DATE)::DATE)::TEXT AS start`, [A, '2026-10-31'])).rows[0].start;
      const after = await als.run({ client: c, companyId: A, userId: crypto.randomUUID(), claims: {} } as never,
        () => registryYearStart(A, '2026-10-31'));
      expect(before).toBe('2026-01-01');
      expect(after).toBe('2026-03-01');
    });
  });
});

describe('REPRO 5 — 940 backfill on a company with no usable financial_year_start', () => {
  it('fiscal_year_link_period (the backfill loop body) links a period of a NULL-start company', async () => {
    await inRolledBackTx(async (c) => {
      const A = await company(c, null);
      await c.query('SAVEPOINT s');
      const e = await attempt(c, () => c.query(`SELECT public.fiscal_year_link_period($1, 2026, '2026-01-01', '2026-01-31')`, [A]));
      expect(e?.message ?? 'linked').toBe('linked');
    });
  });
});

describe('REPRO 6 — 941 re-derives a POSTED journal into (or out of) a locked period on an entry_date update', () => {
  it('refuses moving a posted journal into a locked period', async () => {
    await inRolledBackTx(async (c) => {
      const A = await company(c);
      const user = crypto.randomUUID();
      await c.query(`INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'admin', true)`, [user, `${user}@t.local`]);
      await year(c, A, '2025-06-01');
      await c.query(`UPDATE fiscal_periods SET status = 'locked' WHERE company_id = $1 AND start_date = '2025-07-01'`, [A]);
      const [a1, a2] = [crypto.randomUUID(), crypto.randomUUID()];
      await c.query(
        `INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, normal_balance, level, is_active)
         VALUES ($1, $3, 'B7-1', 'bank', 'asset', 'debit', 3, true), ($2, $3, 'B7-2', 'sales', 'revenue', 'credit', 3, true)`, [a1, a2, A]);
      const je = (await c.query(
        `INSERT INTO gl_journal_entries (company_id, entry_date, created_by, description, status)
         VALUES ($1, '2025-06-20', $2, 'brk807', 'draft') RETURNING id`, [A, user])).rows[0].id;
      await c.query(`INSERT INTO gl_journal_lines (journal_entry_id, gl_account_id, debit, credit, company_id)
                     VALUES ($1, $2, 100, 0, $4), ($1, $3, 0, 100, $4)`, [je, a1, a2, A]);
      await c.query(`UPDATE gl_journal_entries SET status = 'posted' WHERE id = $1`, [je]);
      const moved = await attempt(c, () => c.query(`UPDATE gl_journal_entries SET entry_date = '2025-07-10' WHERE id = $1`, [je]));
      const lockedCache = (await c.query(
        `SELECT COALESCE(sum(b.debit_total), 0)::numeric AS d FROM gl_account_balances b JOIN fiscal_periods fp ON fp.id = b.fiscal_period_id
          WHERE fp.company_id = $1 AND fp.status = 'locked'`, [A])).rows[0].d;
      expect({ refused: moved !== null, lockedPeriodDebits: Number(lockedCache) }).toEqual({ refused: true, lockedPeriodDebits: 0 });
    });
  });
});

describe('REPRO 7 — 940 link on a whole-year period re-cuts every later year of a March company', () => {
  it('a March company keeps March years after a January-December whole-year period', async () => {
    await inRolledBackTx(async (c) => {
      const A = await company(c);
      await c.query(`INSERT INTO fiscal_periods (company_id, period_name, period_number, fiscal_year, start_date, end_date)
                     VALUES ($1, 'FY2025', 1, 2025, '2025-01-01', '2025-12-31')`, [A]);
      await c.query(`INSERT INTO fiscal_periods (company_id, period_name, period_number, fiscal_year, start_date, end_date)
                     VALUES ($1, 'Jun 2026', 6, 2026, '2026-06-01', '2026-06-30')`, [A]);
      const yrs = (await c.query(`SELECT fiscal_year, start_date::text s, end_date::text e FROM fiscal_years WHERE company_id = $1 ORDER BY start_date`, [A])).rows;
      expect(yrs.at(-1)).toEqual({ fiscal_year: 2027, s: '2026-03-01', e: '2027-02-28' });
    });
  });
});
