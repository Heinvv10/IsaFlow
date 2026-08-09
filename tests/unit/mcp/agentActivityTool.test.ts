import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/modules/accounting/services/bank/agentActivityService', () => ({
  listAgentPostings: vi.fn(),
}));

import { listAgentPostings } from '@/modules/accounting/services/bank/agentActivityService';
import { listAgentPostingsTool } from '@/lib/mcp/tools/agentActivity';

const ctx = { companyId: 'company-1', userId: 'user-1' } as never;

beforeEach(() => vi.clearAllMocks());

describe('list_agent_postings', () => {
  it('is read-only — reviewing agent work must never need write scope', () => {
    expect(listAgentPostingsTool.write).toBe(false);
    expect(listAgentPostingsTool.requiresPost).toBeUndefined();
    expect(listAgentPostingsTool.scope).toBe('read:reports');
  });

  it('passes the tenant from ctx, the requested range, and defaults the limit to 50', async () => {
    vi.mocked(listAgentPostings).mockResolvedValue([]);

    await listAgentPostingsTool.handler({ from: '2026-08-01', to: '2026-08-31' }, ctx);

    expect(listAgentPostings).toHaveBeenCalledWith('company-1', '2026-08-01', '2026-08-31', 50);
  });

  it('caps an oversized limit at 100 — an unbounded result set can blow the agent context window', async () => {
    vi.mocked(listAgentPostings).mockResolvedValue([]);

    await listAgentPostingsTool.handler({ from: '2026-08-01', to: '2026-08-31', limit: 9999 }, ctx);

    expect(listAgentPostings).toHaveBeenCalledWith('company-1', '2026-08-01', '2026-08-31', 100);
  });

  it('rejects a missing range rather than scanning the whole ledger', async () => {
    const res = await listAgentPostingsTool.handler({ from: '2026-08-01' }, ctx);

    expect(res.isError).toBe(true);
    expect(listAgentPostings).not.toHaveBeenCalled();
  });
});
