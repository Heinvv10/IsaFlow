import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/modules/accounting/services/bank/bankMatchCandidatesService', () => ({
  getMatchCandidates: vi.fn(),
}));

import { getMatchCandidates } from '@/modules/accounting/services/bank/bankMatchCandidatesService';
import { getMatchCandidatesTool } from '@/lib/mcp/tools/bankMatch';

const ctx = { companyId: 'company-1', userId: 'user-1' } as never;

beforeEach(() => vi.clearAllMocks());

describe('get_match_candidates', () => {
  it('is a read tool — no scope escalation, no idempotency key needed', () => {
    expect(getMatchCandidatesTool.write).toBe(false);
    expect(getMatchCandidatesTool.requiresPost).toBeUndefined();
    expect(getMatchCandidatesTool.scope).toBe('read:bank-tx');
  });

  it('passes the tenant from ctx, never from args', async () => {
    vi.mocked(getMatchCandidates).mockResolvedValue({ candidates: [] });

    await getMatchCandidatesTool.handler({ transaction_id: 'tx-1', company_id: 'attacker' }, ctx);

    expect(getMatchCandidates).toHaveBeenCalledWith('tx-1', 'company-1');
  });

  it('rejects a missing transaction_id without calling the service', async () => {
    const res = await getMatchCandidatesTool.handler({}, ctx);

    expect(res.isError).toBe(true);
    expect(getMatchCandidates).not.toHaveBeenCalled();
  });
});
