/**
 * Opening Balance Equity against isaflow_dev: the account is created once,
 * reused on the second call, sits under the equity header, and the
 * close-readiness check reads the residual from real posted lines.
 * BEGIN … ROLLBACK; DB-gated.
 */
import { describe, it, expect, vi } from 'vitest';
import { als } from '@/lib/als';
import { isDbReachable } from '../helpers/dbReachable';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { getPoolForTests, sql } from '@/lib/neon';
import { ensureOpeningBalanceEquityAccount } from '@/modules/accounting/services/gl/openingBalanceEquityService';
import { openingBalanceEquityCheck } from '@/modules/accounting/services/gl/closeReadinessChecks/openingBalanceEquityCheck';
import { getSystemAccountId, clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';

type AlsCtx = Parameters<typeof als.run>[0];

async function inTx(run: (companyId: string) => Promise<void>) {
  const client = await getPoolForTests().connect();
  try {
    await client.query('BEGIN');
    await als.run({ client, userId: 'test', companyId: 'bootstrap', claims: {} } as unknown as AlsCtx, async () => {
      const rows = (await sql`
        SELECT company_id FROM gl_accounts WHERE account_code = '3000' AND account_type = 'equity'
        ORDER BY company_id LIMIT 1
      `) as Array<{ company_id: string }>;
      if (!rows[0]) throw new Error('no company with a 3000 equity header');
      await run(rows[0].company_id);
    });
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

describe('Opening Balance Equity — real database', async () => {
  const reachable = await isDbReachable();

  it.skipIf(!reachable)('creates once, reuses after, resolves as a system account, and the check sees the residual', async () => {
    await inTx(async (companyId) => {
      clearSystemAccountCache(companyId);
      const first = await ensureOpeningBalanceEquityAccount(companyId);
      const second = await ensureOpeningBalanceEquityAccount(companyId);
      expect(second.id).toBe(first.id);
      expect(second.created).toBe(false);

      const [row] = (await sql`
        SELECT a.account_type, a.account_subtype, a.is_system_account, a.level, p.account_code AS parent_code
        FROM gl_accounts a LEFT JOIN gl_accounts p ON p.id = a.parent_account_id
        WHERE a.id = ${first.id}::uuid AND a.company_id = ${companyId}::uuid
      `) as Array<Record<string, unknown>>;
      expect(row).toMatchObject({ account_type: 'equity', account_subtype: 'opening_balance_equity', is_system_account: true, parent_code: '3000' });
      expect(await getSystemAccountId('opening_balance_equity', companyId)).toBe(first.id);

      expect((await openingBalanceEquityCheck(companyId, { endDate: '2099-12-31' })).status).toBe('pass');

      // Post a real credit to it and the check must warn with that amount.
      const [je] = (await sql`
        INSERT INTO gl_journal_entries (company_id, entry_number, entry_date, description, source, status, created_by)
        VALUES (${companyId}::uuid, 'OBE-T', '2099-01-01', 'obe test', 'manual', 'posted', '00000000-0000-0000-0000-000000000000') RETURNING id
      `) as Array<{ id: string }>;
      await sql`
        INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit)
        VALUES (${companyId}::uuid, ${je!.id}::uuid, ${first.id}::uuid, 0, 250)
      `;
      const before = await openingBalanceEquityCheck(companyId, { endDate: '2098-12-31' });
      const after = await openingBalanceEquityCheck(companyId, { endDate: '2099-12-31' });
      expect(after.status).toBe('warn');
      expect(after.reason).toContain('R250.00');
      // Period-end cut: the same posting is invisible to an earlier period.
      expect(before.reason).not.toContain('R250.00');
    });
  });
});
