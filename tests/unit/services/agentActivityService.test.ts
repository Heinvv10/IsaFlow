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
  it('scopes both the join and the where clause by company, not just one', async () => {
    vi.mocked(sql).mockResolvedValue([] as never);

    await listAgentPostings('company-1', '2026-08-01', '2026-08-31');

    // Inspecting the flattened params alone can't tell "scoped on both
    // tables" apart from "scoped on only one" — a single 'company-1' value
    // would satisfy toContain() either way. Reconstruct the query text from
    // the tagged-template strings array (same pattern as
    // quoteConvertService.test.ts) so deleting either predicate fails this.
    const call = vi.mocked(sql).mock.calls[0]!;
    const queryText = (call[0] as unknown as TemplateStringsArray).join('?');
    const params = call.slice(1);

    expect(queryText).toMatch(/jl\.company_id\s*=\s*\?/);
    expect(queryText).toMatch(/je\.company_id\s*=\s*\?/);
    expect(params).toContain('company-1');
    expect(params).toContain('2026-08-01');
    expect(params).toContain('2026-08-31');
  });

  it('maps a row to the review shape, converting a real pg DATE without a UTC rollback', async () => {
    // pg returns DATE columns as JS Date at local midnight (UTC+2 here) — a
    // string fixture only exercises fmtDate's trivial passthrough branch. The
    // instanceof Date branch is the one that matters: it's what stops the
    // toISODate-style UTC rollback (feedback_toISODate_utc_rollback memory)
    // from reporting 2026-08-03 for a transaction that happened on 08-04.
    vi.mocked(sql).mockResolvedValue([{
      id: 'je-1', entry_number: 'JE-2026-01', entry_date: new Date(2026, 7, 4),
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
