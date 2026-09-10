import { describe, expect, it, vi } from 'vitest';
import { als } from '@/lib/als';
import { getPoolForTests, sql } from '@/lib/neon';
import { getTrialBalanceReport } from '@/modules/accounting/services/gl/trialBalanceService';
import { isDbReachable } from '../../helpers/dbReachable';
import { assertNotProductionDb } from '../../../helpers/assertNotProductionDb';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
import exportHandler from '../../../../pages/api/accounting/trial-balance-export';

const company = '10000000-0000-4000-8000-000000000001';
const foreign = '10000000-0000-4000-8000-000000000002';
const period = '20000000-0000-4000-8000-000000000001';
const legacy = '30000000-0000-4000-8000-000000000001';
const cc1 = '30000000-0000-4000-8000-000000000002';
const cc2 = '30000000-0000-4000-8000-000000000003';
const bu = '30000000-0000-4000-8000-000000000004';
const otherBu = '30000000-0000-4000-8000-000000000005';

// Temporary tables on a single rolled-back connection isolate hand-calculated
// ledger fixtures from all shared dev data. The real report and CSV SQL run.
describe('trial balance dimension coverage (Postgres)', async () => {
  const reachable = await isDbReachable();
  it.skipIf(!reachable)('filters explicit and independent legacy dimensions in balances, brought-forward profit and CSV', async () => {
    assertNotProductionDb('Temporary-table trial balance regression');
    const client = await getPoolForTests().connect();
    try {
      await client.query('BEGIN');
      await als.run({ client, companyId: company, userId: '', claims: {} }, async () => {
        await sql`CREATE TEMP TABLE IF NOT EXISTS companies (id uuid, name text, financial_year_start int) ON COMMIT DROP`;
        await sql`CREATE TEMP TABLE IF NOT EXISTS fiscal_periods (id uuid, company_id uuid, period_name text, start_date date, end_date date) ON COMMIT DROP`;
        await sql`CREATE TEMP TABLE IF NOT EXISTS gl_accounts (id uuid, company_id uuid, account_code text, account_name text, account_type text, normal_balance text) ON COMMIT DROP`;
        await sql`CREATE TEMP TABLE IF NOT EXISTS gl_journal_entries (id uuid, company_id uuid, status text, entry_date date) ON COMMIT DROP`;
        await sql`CREATE TEMP TABLE IF NOT EXISTS gl_journal_lines (company_id uuid, journal_entry_id uuid, gl_account_id uuid, debit numeric, credit numeric, cost_center_id uuid, cc1_id uuid, cc2_id uuid, business_unit_id uuid) ON COMMIT DROP`;
        await sql`INSERT INTO companies VALUES (${company}::uuid, 'Fixture', 3)`;
        await sql`INSERT INTO fiscal_periods VALUES (${period}::uuid, ${company}::uuid, 'April 2026', '2026-04-01', '2026-04-30')`;
        await sql`INSERT INTO gl_accounts VALUES (${company}::uuid, ${company}::uuid, '5000', 'Expense', 'expense', 'debit'), (${foreign}::uuid, ${foreign}::uuid, '5000', 'Foreign expense', 'expense', 'debit')`;
        for (const [id, date, amount, owner, dimensioned] of [
          ['40000000-0000-4000-8000-000000000001', '2026-04-04', 17, company, true],
          ['40000000-0000-4000-8000-000000000002', '2026-02-04', 11, company, true],
          ['40000000-0000-4000-8000-000000000003', '2026-04-04', 100, company, false],
          ['40000000-0000-4000-8000-000000000004', '2026-04-04', 999, foreign, true],
        ] as const) {
          await sql`INSERT INTO gl_journal_entries VALUES (${id}::uuid, ${owner}::uuid, 'posted', ${date}::date)`;
          await sql`INSERT INTO gl_journal_lines VALUES (${owner}::uuid, ${id}::uuid, ${owner}::uuid, ${amount}, 0,
            ${dimensioned ? legacy : null}::uuid, ${dimensioned ? cc1 : null}::uuid, ${dimensioned ? cc2 : null}::uuid,
            ${dimensioned ? bu : otherBu}::uuid)`;
        }
        // A legacy-only line remains visible after introducing explicit fields.
        await sql`INSERT INTO gl_journal_lines VALUES (${company}::uuid, '40000000-0000-4000-8000-000000000001', ${company}::uuid, 3, 0, ${legacy}::uuid, NULL, NULL, ${otherBu}::uuid)`;
        for (const [selected, movement] of [[legacy, 20], [cc1, 17], [cc2, 17]] as const) {
          const report = await getTrialBalanceReport(company, period, { costCentreId: selected });
          expect(report.rows.find(r => r.accountCode === '5000'), selected).toMatchObject({ debitBalance: movement, periodDebit: movement });
          expect(report.rows.find(r => r.accountCode === 'RE-BF'), selected).toMatchObject({ debitBalance: 11 });
        }
        expect((await getTrialBalanceReport(company, period)).rows.find(r => r.accountCode === '5000')).toMatchObject({ debitBalance: 120 });
        const byBu = await getTrialBalanceReport(company, period, { businessUnitId: bu });
        expect(byBu.rows.find(r => r.accountCode === '5000')).toMatchObject({ debitBalance: 17, periodDebit: 17 });
        expect(byBu.rows.find(r => r.accountCode === 'RE-BF')).toMatchObject({ debitBalance: 11 });
        const combined = await getTrialBalanceReport(company, period, { costCentreId: legacy, businessUnitId: otherBu });
        expect(combined.rows.find(r => r.accountCode === '5000')).toMatchObject({ debitBalance: 3, periodDebit: 3 });
        const req = { method: 'GET', companyId: company, query: { fiscal_period_id: period, business_unit_id: bu } } as unknown as NextApiRequest;
        let csv = '';
        const res = { setHeader: vi.fn(), status: () => res, send: (body: string) => { csv = body; }, json: vi.fn() };
        await exportHandler(req, res as unknown as NextApiResponse);
        expect(csv).toContain('"5000","Expense","expense","debit",0.00,0.00,17.00,0.00,17.00,0.00');
        expect(csv).not.toContain('120.00');
      });
    } finally {
      try { await client.query('ROLLBACK'); } finally { client.release(); }
    }
  });
});
