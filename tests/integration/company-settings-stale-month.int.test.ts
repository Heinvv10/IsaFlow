/**
 * A settings save writes companies.financial_year_start only while the row
 * still holds the month the caller loaded (Hein, PR #1551). Otherwise it is
 * refused, 409 CompanySettingsStaleError, before anything is written. A 4xx
 * COMMITS the request transaction (withAuth rolls back only at 500 and above),
 * so every refusal here is followed by a COMMIT, as the route's would be, and
 * the row is read back unchanged.
 *
 * Callers (companyService.updateCompany):
 *   - the settings page (PUT /api/accounting/companies) sends financialYearStart
 *     AND loadedFinancialYearStart: guarded;
 *   - financialYearStart without loadedFinancialYearStart: refused, 400
 *     (FinancialYearStartLoadedMissingError), the server cannot tell a stale
 *     month from a meant one;
 *   - no financialYearStart (MCP company_profile update, admin PATCH): no guard;
 *     the column keeps the row's own month (COALESCE over the row version the
 *     UPDATE locks), so such a save can never write a stale month.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { als } from '@/lib/als';
import { updateCompany } from '@/modules/accounting/services/core/companyService';
import { generateFiscalYearForDate } from '@/modules/accounting/services/gl/fiscalYearGenerator';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const user = crypto.randomUUID();
const made: string[] = [];

beforeAll(async () => {
  await pool.query(`INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'admin', true)`, [user, `${user}@test.local`]);
});

afterAll(async () => {
  try {
    for (const id of made) {
      await pool.query('DELETE FROM audit_log WHERE company_id = $1', [id]);
      await pool.query('DELETE FROM fiscal_periods WHERE company_id = $1', [id]).catch(() => undefined);
      await pool.query('DELETE FROM fiscal_years WHERE company_id = $1', [id]).catch(() => undefined);
      await pool.query('DELETE FROM companies WHERE id = $1', [id]).catch(() => undefined);
    }
    await pool.query('DELETE FROM users WHERE id = $1', [user]);
  } finally { await pool.end(); }
}, 60000);

/** updateCompany in a request transaction that COMMITs whatever happens (a 4xx commits). Resolves to 'ok' or the error. */
async function save(c: string, input: Record<string, unknown>): Promise<unknown> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await als.run({ client, companyId: c, userId: user, claims: {} } as never,
      () => updateCompany(c, input)).then(() => 'ok', (e: unknown) => e);
    await client.query('COMMIT');
    return out;
  } finally { client.release(); }
}

async function newCompany(month: number): Promise<string> {
  const c = crypto.randomUUID();
  made.push(c);
  await pool.query(`INSERT INTO companies (id, name, financial_year_start) VALUES ($1, 'STALE co', $2)`, [c, month]);
  return c;
}

async function row(c: string) {
  const { rows: [co] } = await pool.query('SELECT name, financial_year_start AS month FROM companies WHERE id = $1', [c]);
  return co as { name: string; month: number };
}

const nameOf = (e: unknown) => (e === 'ok' ? 'ok' : (e as Error).name);

describe('settings save: financial_year_start only over the month the caller loaded', () => {
  it('the loaded month is still the row\'s: the save is written', async () => {
    const c = await newCompany(3);
    expect(nameOf(await save(c, { name: 'Saved', financialYearStart: 3, loadedFinancialYearStart: 3 }))).toBe('ok');
    expect(await row(c)).toEqual({ name: 'Saved', month: 3 });
  });

  it('the row moved on since the load: 409, and nothing is written', async () => {
    const c = await newCompany(3);   // a change of year end set March after the caller loaded January
    const out = await save(c, { name: 'Stale', financialYearStart: 1, loadedFinancialYearStart: 1 });
    expect(nameOf(out)).toBe('CompanySettingsStaleError');
    expect((out as Error).message).toBe('Company settings changed since you loaded them — reload and try again');
    expect(await row(c)).toEqual({ name: 'STALE co', month: 3 });
  });

  it('a start-month change over a stale load: 409 before the rebuild; the periods are untouched', async () => {
    const c = await newCompany(3);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await als.run({ client, companyId: c, userId: user, claims: {} } as never, () => generateFiscalYearForDate(c, '2026-03-01'));
      await client.query('COMMIT');
    } finally { client.release(); }
    const before = (await pool.query('SELECT id FROM fiscal_periods WHERE company_id = $1 ORDER BY id', [c])).rows;
    expect(before).toHaveLength(12);

    expect(nameOf(await save(c, { name: 'Stale', financialYearStart: 7, loadedFinancialYearStart: 1 })))
      .toBe('CompanySettingsStaleError');
    expect(await row(c)).toEqual({ name: 'STALE co', month: 3 });
    expect((await pool.query('SELECT id FROM fiscal_periods WHERE company_id = $1 ORDER BY id', [c])).rows).toEqual(before);
  });

  it('financialYearStart without the loaded month: 400 (cannot be judged), and nothing is written', async () => {
    const c = await newCompany(3);
    expect(nameOf(await save(c, { name: 'Unjudged', financialYearStart: 3 }))).toBe('FinancialYearStartLoadedMissingError');
    expect(nameOf(await save(c, { name: 'Unjudged', financialYearStart: 3, loadedFinancialYearStart: 'March' })))
      .toBe('FinancialYearStartLoadedMissingError');
    expect(await row(c)).toEqual({ name: 'STALE co', month: 3 });
  });

  it('no financialYearStart (MCP company_profile, admin PATCH): written, and the row keeps its own month', async () => {
    const c = await newCompany(3);
    expect(nameOf(await save(c, { name: 'Profile only' }))).toBe('ok');
    expect(await row(c)).toEqual({ name: 'Profile only', month: 3 });
  });

  it('NULL and 0 in the row read as March, as the page loads them', async () => {
    const c = await newCompany(3);
    await pool.query('UPDATE companies SET financial_year_start = NULL WHERE id = $1', [c]);
    expect(nameOf(await save(c, { name: 'From NULL', financialYearStart: 3, loadedFinancialYearStart: 3 }))).toBe('ok');
    expect(await row(c)).toEqual({ name: 'From NULL', month: 3 });
  });
});
