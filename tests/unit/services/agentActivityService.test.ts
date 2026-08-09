import { describe, it, expect, vi, beforeEach } from 'vitest';

// Spread the real module so fmtDate stays REAL — the service imports it, and
// the date behaviour (fmtDate does not roll pg DATEs back a day on this UTC+2
// server, toISODate does) is exactly what must not be mocked away.
// Same pattern as tests/unit/services/quoteConvertService.test.ts.
vi.mock('@/lib/neon', async () => {
  const original = await vi.importActual<typeof import('@/lib/neon')>('@/lib/neon');
  const sqlFn = Object.assign(vi.fn(), { transaction: vi.fn() });
  return { ...original, sql: sqlFn };
});
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

import { sql } from '@/lib/neon';
import { listAgentPostings } from '@/modules/accounting/services/bank/agentActivityService';

beforeEach(() => vi.clearAllMocks());

describe('listAgentPostings', () => {
  it('scopes by company and the requested date range', async () => {
    vi.mocked(sql).mockResolvedValue([] as never);

    await listAgentPostings('company-1', '2026-08-01', '2026-08-31');

    const params = vi.mocked(sql).mock.calls[0]!.slice(1);
    expect(params).toContain('company-1');
    expect(params).toContain('2026-08-01');
    expect(params).toContain('2026-08-31');
  });

  it('maps a row to the review shape', async () => {
    vi.mocked(sql).mockResolvedValue([{
      id: 'je-1', entry_number: 'JE-2026-01', entry_date: '2026-08-04',
      description: 'Absa line', posting_agent: 'mcp:allocate_bank_transaction:v1',
      status: 'posted', amount: '1250.00',
    }] as never);

    const rows = await listAgentPostings('company-1', '2026-08-01', '2026-08-31');

    expect(rows).toEqual([{
      journalEntryId: 'je-1', entryNumber: 'JE-2026-01', entryDate: '2026-08-04',
      description: 'Absa line', postingAgent: 'mcp:allocate_bank_transaction:v1',
      status: 'posted', amount: 1250,
    }]);
  });
});
