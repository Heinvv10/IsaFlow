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

    await getMatchCandidatesTool.handler({ transaction_id: '045ef594-d81d-4f21-84d6-1151ed71260d', company_id: 'attacker' }, ctx);

    expect(getMatchCandidates).toHaveBeenCalledWith('045ef594-d81d-4f21-84d6-1151ed71260d', 'company-1');
  });

  it('rejects a missing transaction_id without calling the service', async () => {
    const res = await getMatchCandidatesTool.handler({}, ctx);

    expect(res.isError).toBe(true);
    expect(getMatchCandidates).not.toHaveBeenCalled();
  });

  // ── The catch path is the one an agent hits on a bad id, and it is the one
  // that can leak. An unhandled rejection would surface the raw error (schema
  // names, SQLSTATE) through the transport instead of a tool result.
  it('turns a service rejection into an isError result rather than throwing', async () => {
    vi.mocked(getMatchCandidates).mockRejectedValue(new Error('Bank transaction not found'));

    const res = await getMatchCandidatesTool.handler({ transaction_id: 'e4ed29ea-9b46-4cad-8c27-8b94b356dd05' }, ctx);

    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('not found'); // plain Error → safe to surface
  });

  it('generic-ifies a pg driver error — no schema names, no SQLSTATE, no stack', async () => {
    vi.mocked(getMatchCandidates).mockRejectedValue(
      Object.assign(new Error('column bmc.supplier_invoice_idx does not exist'), { code: '42703' }),
    );

    const res = await getMatchCandidatesTool.handler({ transaction_id: '045ef594-d81d-4f21-84d6-1151ed71260d' }, ctx);

    expect(res.isError).toBe(true);
    const text = res.content[0]!.text;
    expect(text).toBe('Failed to load match candidates.');
    expect(text).not.toContain('supplier_invoice_idx');
    expect(text).not.toContain('column');
    expect(text).not.toContain('42703');
  });
});
