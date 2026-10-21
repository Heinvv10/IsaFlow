/**
 * Connect to Sage on real PostgreSQL — the guards around a take-on, split out
 * of sage-connect-takeon.int.test.ts: IsaFlow's fiscal year comes from its
 * fiscal_periods (R2), and sage_connect_pulls is under active-company RLS.
 * Everything runs in one transaction that is rolled back.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { SageImportRefused } from '@/modules/accounting/services/sage/sageTakeOnImportService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { sageFixture } from '../unit/services/sage/sageFixture';
import {
  books, importAsRoute, inRolledBackCompany as inCompany, storeReady,
} from './sage-connect-takeon.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
afterAll(() => pool.end());
const inRolledBackCompany = (fn: Parameters<typeof inCompany>[1], yearStart?: string | null) => inCompany(pool, fn, yearStart);

describe('R2: the fiscal year comes from fiscal_periods', () => {
  it('a company whose periods run January to December is refused, naming both starts (companies.financial_year_start says 3)', async () => {
    await inRolledBackCompany(async (c, companyId, userId) => {
      const pullId = await storeReady(companyId, userId, sageFixture());
      const before = await books(c, companyId);
      const err = await importAsRoute(companyId, userId, pullId).then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(SageImportRefused);
      expect((err as SageImportRefused).issues).toContainEqual(expect.objectContaining({
        area: 'company', message: expect.stringMatching(/2026-03-01.*2026-01-01 to 2026-12-31/),
      }));
      expect(await books(c, companyId)).toEqual(before);
    }, '2026-01-01');
  });

  it('a company with no fiscal period for the cut-over date is refused with what to do', async () => {
    await inRolledBackCompany(async (_c, companyId, userId) => {
      const pullId = await storeReady(companyId, userId, sageFixture());
      const err = await importAsRoute(companyId, userId, pullId).then(() => null, (e: unknown) => e);
      expect((err as SageImportRefused).issues).toContainEqual(expect.objectContaining({
        area: 'company', message: expect.stringContaining('no fiscal period covering 2026-10-21'),
      }));
    }, null);
  });
});

describe('sage_connect_pulls under RLS (app_user, the routes\' role)', () => {
  it('a member working in one company sees and writes only that company\'s Sage reads, even another company they belong to', async () => {
    await inRolledBackCompany(async (c, companyA, userId) => {
      const companyB = randomUUID();
      await c.query('INSERT INTO companies(id,name) VALUES($1,$2)', [companyB, 'Sage connect take-on B']);
      await c.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')", [companyB, userId]);
      const insert = (co: string) => c.query(
        "INSERT INTO sage_connect_pulls (company_id, created_by, sage_company_id, as_at_date) VALUES ($1, $2, 1, '2026-10-21') RETURNING id", [co, userId]);
      await insert(companyA);
      const rowB = (await insert(companyB)).rows[0]!.id as string;

      await c.query('SAVEPOINT rls');
      await c.query('SET LOCAL ROLE app_user');
      await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId })]);
      await c.query("SELECT set_config('app.current_company_id', $1, true)", [companyA]);
      const seen = (await c.query('SELECT company_id FROM sage_connect_pulls')).rows.map((r) => r.company_id);
      expect(seen).toEqual([companyA]);
      expect((await c.query("UPDATE sage_connect_pulls SET status = 'discarded' WHERE id = $1", [rowB])).rowCount).toBe(0);
      await expect(insert(companyB)).rejects.toThrow(/row-level security/);
      await c.query('ROLLBACK TO SAVEPOINT rls');
      await expect(c.query('SAVEPOINT del; SET LOCAL ROLE app_user; DELETE FROM sage_connect_pulls')).rejects.toThrow(/permission denied/);
      await c.query('ROLLBACK TO SAVEPOINT del');
    });
  });
});
