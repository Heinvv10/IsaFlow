import { randomUUID } from 'crypto';
import { describe, expect, it, vi } from 'vitest';
import { als } from '@/lib/als';
import { getPoolForTests, sql } from '@/lib/neon';
import { allocateTransaction, reverseReconciledTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import { getJournalEntryById } from '@/modules/accounting/services/gl/journalEntryCrudService';
import { getTrialBalance } from '@/modules/accounting/services/gl/trialBalanceService';
import { isDbReachable } from '../helpers/dbReachable';
import { assertNotProductionDb } from '../../helpers/assertNotProductionDb';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

describe('bank allocation dimension workflow (Postgres)', async () => {
  const reachable = await isDbReachable();
  it.skipIf(!reachable)('preserves CC1/CC2 in the bank row, journal, report and reversal', async () => {
    assertNotProductionDb('Rolled-back bank allocation dimension workflow');
    const client = await getPoolForTests().connect();
    try {
      await client.query('BEGIN');
      await als.run({ client, userId: '', claims: {} }, async () => {
        const [f] = await sql`
          SELECT je.company_id, je.created_by, fp.id AS period_id, fp.start_date::TEXT AS entry_date,
                 b.id AS bank_id, a.id AS account_id, a.account_code
          FROM gl_journal_entries je
          JOIN fiscal_periods fp ON fp.company_id = je.company_id AND fp.status = 'open'
          JOIN gl_accounts b ON b.company_id = je.company_id AND b.is_active AND b.account_subtype = 'bank'
          JOIN gl_accounts a ON a.company_id = je.company_id AND a.is_active AND a.account_type = 'expense'
          ORDER BY je.company_id, fp.start_date, a.account_code LIMIT 1`;
        if (!f) throw new Error('Need an open period, journal author, bank and expense account');
        const companyId = String(f.company_id), userId = String(f.created_by);
        await als.run({ client, companyId, userId, claims: {} }, async () => {
          const cc1Id = randomUUID(), cc2Id = randomUUID();
          for (const [id, type] of [[cc1Id, 'cc1'], [cc2Id, 'cc2']]) {
            await sql`INSERT INTO cost_centres (id, company_id, code, name, cc_type)
              VALUES (${id}::UUID, ${companyId}::UUID, ${id!.slice(0, 12)}, 'Bank dimension fixture', ${type})`;
          }
          const [tx] = await sql`INSERT INTO bank_transactions
            (company_id, bank_account_id, transaction_date, amount, description, status)
            VALUES (${companyId}::UUID, ${String(f.bank_id)}::UUID, ${String(f.entry_date)}::DATE,
              -137, 'Bank dimension regression', 'imported') RETURNING id`;
          const result = await allocateTransaction(companyId, String(tx!.id), String(f.account_id), userId,
            undefined, 'account', undefined, 'none', cc1Id, cc2Id);
          expect(result.bankTransaction).toMatchObject({ cc1Id, cc2Id, status: 'allocated' });
          const report = await getTrialBalance(companyId, String(f.period_id), cc1Id);
          expect(report.find(row => row.accountCode === String(f.account_code)))
            .toMatchObject({ debitBalance: 137, periodDebit: 137 });
          const entry = await getJournalEntryById(companyId, result.journalEntryId);
          expect(entry?.lines.find(line => line.glAccountId === String(f.account_id)))
            .toMatchObject({ costCenterId: cc1Id, cc1Id, cc2Id });
          expect(entry?.lines.find(line => line.glAccountId === String(f.bank_id)))
            .toMatchObject({ cc1Id: undefined, cc2Id: undefined });
          await sql`UPDATE cost_centres SET is_active = false
            WHERE company_id = ${companyId}::UUID AND id IN (${cc1Id}::UUID, ${cc2Id}::UUID)`;
          await reverseReconciledTransaction(companyId, String(tx!.id), userId);
          const groups = await sql`SELECT jl.cc1_id, jl.cc2_id, SUM(jl.debit - jl.credit)::TEXT AS net
            FROM gl_journal_lines jl JOIN gl_journal_entries je
              ON je.id = jl.journal_entry_id AND je.company_id = jl.company_id
            WHERE jl.company_id = ${companyId}::UUID AND je.company_id = ${companyId}::UUID
              AND jl.cc1_id = ${cc1Id}::UUID AND je.status = 'posted'
            GROUP BY jl.cc1_id, jl.cc2_id`;
          expect(groups).toEqual([{ cc1_id: cc1Id, cc2_id: cc2Id, net: '0.00' }]);
          const reversedReport = await getTrialBalance(companyId, String(f.period_id), cc1Id);
          expect(reversedReport.find(row => row.accountCode === String(f.account_code)))
            .toMatchObject({ debitBalance: 0, creditBalance: 0, periodDebit: 137, periodCredit: 137 });
          const [other] = await sql`SELECT id FROM companies WHERE id <> ${companyId}::UUID LIMIT 1`;
          if (!other) throw new Error('Need a second company for ownership regression');
          const foreignId = randomUUID();
          await sql`INSERT INTO cost_centres (id, company_id, code, name, cc_type)
            VALUES (${foreignId}::UUID, ${String(other.id)}::UUID, ${foreignId.slice(0, 12)},
              'Foreign bank dimension fixture', 'cc2')`;
          for (const field of ['cc1', 'cc2']) {
            for (const invalidId of [foreignId, randomUUID(), 'not-a-uuid']) {
              await expect(allocateTransaction(companyId, String(tx!.id), String(f.account_id), userId,
                undefined, 'account', undefined, 'none',
                field === 'cc1' ? invalidId : undefined, field === 'cc2' ? invalidId : undefined))
                .rejects.toThrow('Cost centre must belong to this company');
              const [unchanged] = await sql`SELECT status, matched_journal_line_id FROM bank_transactions
                WHERE company_id = ${companyId}::UUID AND id = ${String(tx!.id)}::UUID`;
              expect(unchanged).toMatchObject({ status: 'imported', matched_journal_line_id: null });
            }
          }
        });
      });
    } finally {
      try { await client.query('ROLLBACK'); } finally { client.release(); }
    }
  }, 30_000);
});
