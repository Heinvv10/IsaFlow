import { describe, expect, it, vi } from 'vitest';
import { als } from '@/lib/als';
import { getPoolForTests, sql } from '@/lib/neon';
import { getTrialBalanceReport } from '@/modules/accounting/services/gl/trialBalanceService';
import { isDbReachable } from '../../helpers/dbReachable';
import { assertNotProductionDb } from '../../../helpers/assertNotProductionDb';
import {
  insertAccount, insertBusinessUnit, insertCompany, insertCostCentre, insertPeriod,
} from '../../helpers/realLedgerRows';
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

// Real rows in one transaction that is always rolled back isolate hand-calculated
// ledger fixtures from all shared dev data (the companies are fixture-only). The
// real report and CSV SQL run.
describe('trial balance dimension coverage (Postgres)', async () => {
  const reachable = await isDbReachable();
  it.skipIf(!reachable)('filters CC1, CC2 and BU in balances, brought-forward profit and CSV; a legacy cost_center_id is read by nothing', async () => {
    assertNotProductionDb('Temporary-table trial balance regression');
    const client = await getPoolForTests().connect();
    try {
      await client.query('BEGIN');
      await als.run({ client, companyId: company, userId: '', claims: {} }, async () => {
        await insertCompany(company, 3);
        await insertCompany(foreign, 3, 'Foreign');
        await insertPeriod(period, company, '2026-04-01', '2026-04-30');
        await insertAccount(company, company, '5000', 'Expense', 'expense', 'debit');
        await insertAccount(foreign, foreign, '5000', 'Foreign expense', 'expense', 'debit');
        // The dimension columns are real foreign keys: the tags need rows to point at.
        await insertCostCentre(cc1, company, 'CC1');
        await insertCostCentre(cc2, company, 'CC2');
        await insertCostCentre(legacy, company, 'LEG');
        await insertBusinessUnit(bu, company, 'BU1');
        await insertBusinessUnit(otherBu, company, 'BU2');
        for (const [id, date, amount, owner, dimensioned] of [
          ['40000000-0000-4000-8000-000000000001', '2026-04-04', 17, company, true],
          ['40000000-0000-4000-8000-000000000002', '2026-02-04', 11, company, true],
          ['40000000-0000-4000-8000-000000000003', '2026-04-04', 100, company, false],
          ['40000000-0000-4000-8000-000000000004', '2026-04-04', 999, foreign, true],
        ] as const) {
          // Each journal is a single one-sided line (the hand-calculated shape), so it cannot go
          // through the draft -> posted UPDATE that enforce_balanced_entry checks; that trigger
          // is UPDATE-only, so the header is inserted already posted, as a legacy import would.
          await sql`INSERT INTO gl_journal_entries (id, company_id, status, entry_date, source, created_by)
            VALUES (${id}::uuid, ${owner}::uuid, 'posted', ${date}::date, 'manual', '00000000-0000-4000-8000-000000000000'::uuid)`;
          await sql`INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit,
              cost_center_id, cc1_id, cc2_id, bu_id)
            VALUES (${owner}::uuid, ${id}::uuid, ${owner}::uuid, ${amount}, 0,
            ${dimensioned ? legacy : null}::uuid, ${dimensioned ? cc1 : null}::uuid, ${dimensioned ? cc2 : null}::uuid,
            ${dimensioned ? bu : otherBu}::uuid)`;
        }
        // A legacy line in sync with its CC1 (cc1_id = the legacy id), as prod's are. The
        // other lines' cost_center_id is a drifted legacy value that no report reads
        // (PR #688 round 2: CC1 is cc1_id alone).
        await sql`INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit, cost_center_id, cc1_id, cc2_id, bu_id)
          VALUES (${company}::uuid, '40000000-0000-4000-8000-000000000001', ${company}::uuid, 3, 0, ${legacy}::uuid, ${legacy}::uuid, NULL, ${otherBu}::uuid)`;
        for (const [selected, movement, broughtForward] of [[legacy, 3, undefined], [cc1, 17, 11], [cc2, 17, 11]] as const) {
          const report = await getTrialBalanceReport(company, period, { costCentreId: selected });
          expect(report.rows.find(r => r.accountCode === '5000'), selected).toMatchObject({ debitBalance: movement, periodDebit: movement });
          expect(report.rows.find(r => r.accountCode === 'RE-BF')?.debitBalance, selected).toBe(broughtForward);
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
