import { randomUUID } from 'crypto';
import { describe, expect, it, vi } from 'vitest';
import { als } from '@/lib/als';
import { getPoolForTests, sql } from '@/lib/neon';
import { createJournalEntry, getJournalEntryById } from '@/modules/accounting/services/gl/journalEntryCrudService';
import { postJournalEntry, reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostingService';
import { isDbReachable } from '../../helpers/dbReachable';
import { assertNotProductionDb } from '../../../helpers/assertNotProductionDb';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

describe('journal cost-centre dimensions (Postgres)', async () => {
  const reachable = await isDbReachable();

  it.skipIf(!reachable)('preserves independent legacy, CC1 and CC2 attribution through posting and reversal', async () => {
    assertNotProductionDb('Rolled-back journal dimension workflow');
    const client = await getPoolForTests().connect();
    try {
      await client.query('BEGIN');
      await als.run({ client, userId: '', claims: {} }, async () => {
        const [fixture] = await sql`
          SELECT je.company_id, je.created_by, fp.id AS period_id,
                 fp.start_date::TEXT AS entry_date,
                 a.id AS account_id
          FROM gl_journal_entries je
          JOIN fiscal_periods fp ON fp.company_id = je.company_id AND fp.status = 'open'
          JOIN gl_accounts a ON a.company_id = je.company_id
            AND a.is_active = true AND a.account_type = 'expense'
          ORDER BY je.company_id, fp.start_date, a.account_code LIMIT 1
        `;
        if (!fixture) throw new Error('Need a company with an open period, journal author and active account');
        const companyId = String(fixture.company_id);
        const userId = String(fixture.created_by);
        await als.run({ client, companyId, userId, claims: {} }, async () => {
          const ids = [randomUUID(), randomUUID(), randomUUID()];
          for (const [i, id] of ids.entries()) {
            await sql`INSERT INTO cost_centres (id, company_id, code, name, cc_type)
              VALUES (${id}::UUID, ${companyId}::UUID, ${id.slice(0, 12)},
                'Dimension regression fixture', ${i === 2 ? 'cc2' : 'cc1'})`;
          }
          const dimensions = { costCenterId: ids[0], cc1Id: ids[1], cc2Id: ids[2] };
          const accountId = String(fixture.account_id);
          const original = await createJournalEntry(companyId, {
            entryDate: String(fixture.entry_date), fiscalPeriodId: String(fixture.period_id),
            lines: [
              { glAccountId: accountId, debit: 137, credit: 0, ...dimensions },
              { glAccountId: accountId, debit: 0, credit: 137 },
            ],
          }, userId);
          const readback = await getJournalEntryById(companyId, original.id);
          expect(readback?.lines.find(line => line.debit === 137)).toMatchObject(dimensions);
          await postJournalEntry(companyId, original.id, userId);
          // Withdrawing a picker option must not prevent correcting its history.
          await sql`UPDATE cost_centres SET is_active = false
            WHERE company_id = ${companyId}::UUID AND id IN (${ids[1]}::UUID, ${ids[2]}::UUID)`;
          const contra = await reverseJournalEntry(companyId, original.id, userId);
          const reversed = await getJournalEntryById(companyId, contra.id);
          expect(reversed?.lines.find(line => line.credit === 137)).toMatchObject(dimensions);
          const groups = await sql`
            SELECT jl.cost_center_id, jl.cc1_id, jl.cc2_id, SUM(jl.debit - jl.credit)::TEXT AS net
            FROM gl_journal_lines jl
            JOIN gl_journal_entries je ON je.id = jl.journal_entry_id AND je.company_id = jl.company_id
            WHERE jl.company_id = ${companyId}::UUID AND je.company_id = ${companyId}::UUID
              AND je.id IN (${original.id}::UUID, ${contra.id}::UUID) AND je.status = 'posted'
            GROUP BY jl.cost_center_id, jl.cc1_id, jl.cc2_id
          `;
          expect(groups).toHaveLength(2);
          expect(groups.every(group => Number(group.net) === 0)).toBe(true);

          const [other] = await sql`SELECT id FROM companies WHERE id <> ${companyId}::UUID LIMIT 1`;
          if (!other) throw new Error('Need a second company for ownership regression');
          const foreignId = randomUUID();
          await sql`INSERT INTO cost_centres (id, company_id, code, name, cc_type)
            VALUES (${foreignId}::UUID, ${String(other.id)}::UUID, ${foreignId.slice(0, 12)},
              'Foreign dimension fixture', 'cc1')`;
          for (const field of ['cc1Id', 'cc2Id']) {
            for (const invalidId of [foreignId, randomUUID(), 'not-a-uuid']) {
              await expect(createJournalEntry(companyId, {
                entryDate: String(fixture.entry_date), fiscalPeriodId: String(fixture.period_id),
                lines: [
                  { glAccountId: accountId, debit: 137, credit: 0, [field]: invalidId },
                  { glAccountId: accountId, debit: 0, credit: 137 },
                ],
              }, userId)).rejects.toThrow('Cost centre must belong to this company');
            }
          }
        });
      });
    } finally {
      try { await client.query('ROLLBACK'); } finally { client.release(); }
    }
  }, 30_000);
});
