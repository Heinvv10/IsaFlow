import { expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { withControlRequest, requireControlTx } from '@/modules/accounting/services/controls/context';
import { materializePeriodOperation } from '@/modules/accounting/services/controls/periodOperationMaterializer';
const company = 'b1111111-1111-4111-8111-111111111111', id = 'b2222222-2222-4222-8222-222222222222';
it.each(['journal', 'line'])('refuses an oversized %s population instead of binding truncated evidence', async population => {
  const query = vi.fn(async (text: string) => ({ rows:
    text.includes('FROM companies') ? [{ id: company, default_currency: 'ZAR', lockdown_enabled: false, lockdown_date: null }]
      : text.includes('FROM fiscal_periods') ? [{ id, fiscal_year: 2026, start_date: '2026-01-01', end_date: '2026-01-31', status: 'open' }]
        : text.includes('FROM gl_journal_entries') ? Array.from({ length: population === 'journal' ? 10001 : 1 }, () => ({ id }))
          : text.includes('FROM gl_journal_lines') ? Array.from({ length: 50001 }, () => ({ id, gl_account_id: id })) : [] }));
  const client = { query } as unknown as PoolClient;
  await expect(withControlRequest({ client, userId: 'u1', companyId: company, claims: {} },
    { personId: 'u1', companyId: company, authMethod: 'cookie' }, () => materializePeriodOperation(requireControlTx(),
      { entityType: 'fiscal_period', entityId: id, operation: 'fiscal_period.close' }))).rejects.toThrow('synchronous control limit');
});
