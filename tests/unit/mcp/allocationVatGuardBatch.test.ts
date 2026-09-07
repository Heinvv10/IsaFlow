/**
 * The bulk path resolves the batch's accounts ONCE.
 *
 * Unbatched, a 500-line run of standard-coded account lines does up to two
 * sequential SELECTs per line inside the savepoint loop — and a salary batch
 * is exactly that shape, so the worst case is the case this guard exists for.
 * `resolveRuleVatCode` already has a batched path; it just needs both facts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { fetchVatDenialFlags, fetchAccountNames, resolveRuleVatCode } = vi.hoisted(() => ({
  fetchVatDenialFlags: vi.fn(),
  fetchAccountNames: vi.fn(),
  resolveRuleVatCode: vi.fn(),
}));

vi.mock('@/modules/accounting/services/gl/inputVatDenial', () => ({ fetchVatDenialFlags }));
vi.mock('@/modules/accounting/services/gl/nonSupplyVatGuard', () => ({ fetchAccountNames }));
vi.mock('@/modules/accounting/services/gl/ruleVatResolution', () => ({ resolveRuleVatCode }));

import {
  prefetchAllocationVatFacts, resolveLineVatCode,
} from '@/lib/mcp/tools/allocationVatGuard';

const CO = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const A1 = 'gggggggg-0000-0000-0000-000000000001';
const A2 = 'gggggggg-0000-0000-0000-000000000002';

beforeEach(() => {
  vi.clearAllMocks();
  resolveRuleVatCode.mockResolvedValue({ vatCode: 'standard', denied: false, nonSupplyCoerced: false });
});

describe('prefetchAllocationVatFacts', () => {
  it('queries once per fact for the whole batch, de-duplicating accounts', async () => {
    fetchVatDenialFlags.mockResolvedValue(new Map([[A1, false], [A2, true]]));
    fetchAccountNames.mockResolvedValue(new Map([[A1, 'Salaries & Wages'], [A2, 'Staff Welfare']]));

    // 500 lines, two distinct accounts.
    const ids = Array.from({ length: 500 }, (_, i) => (i % 2 ? A1 : A2));
    const facts = await prefetchAllocationVatFacts(CO, ids);

    expect(fetchVatDenialFlags).toHaveBeenCalledTimes(1);
    expect(fetchAccountNames).toHaveBeenCalledTimes(1);
    expect(fetchVatDenialFlags.mock.calls[0]![1], 'must de-duplicate').toHaveLength(2);
    expect(facts.names.get(A1)).toBe('Salaries & Wages');
  });

  it('does not query at all when no line names an account', async () => {
    const facts = await prefetchAllocationVatFacts(CO, [undefined, null, '']);
    expect(fetchVatDenialFlags).not.toHaveBeenCalled();
    expect(fetchAccountNames).not.toHaveBeenCalled();
    expect(facts.denied.size).toBe(0);
  });
});

describe('resolveLineVatCode — using the prefetch', () => {
  const line = { allocType: 'account', contraAccountId: A1, vatCode: 'standard' };

  it('passes the prefetched facts through so the resolver can batch', async () => {
    const facts = {
      denied: new Map([[A1, false]]),
      names: new Map([[A1, 'Salaries & Wages']]),
    };

    await resolveLineVatCode(CO, 'tx-1', line, 'bulk', facts);

    expect(resolveRuleVatCode).toHaveBeenCalledWith(expect.objectContaining({
      ruleGlAccountVatDenied: false,
      ruleGlAccountName: 'Salaries & Wages',
    }));
  });

  it('falls back to the per-line lookup when the account is missing from the prefetch', async () => {
    // An absent fact means "look it up", never "skip the check" — passing only
    // one of the two would silently run half the guard.
    const facts = { denied: new Map([[A1, false]]), names: new Map<string, string>() };

    await resolveLineVatCode(CO, 'tx-1', line, 'bulk', facts);

    expect(resolveRuleVatCode).toHaveBeenCalledWith(expect.objectContaining({
      ruleGlAccountVatDenied: undefined,
      ruleGlAccountName: undefined,
    }));
  });

  it('treats a NULL account name the same on both routes', async () => {
    // The prefetch coalesces a NULL name to '', the per-line fallback passes
    // null through. They agree only because both fail the same truthiness
    // check in shouldWarnOnNonSupply — pinned here so a future change to
    // either side has to keep them agreeing rather than discovering they
    // diverged on a live batch.
    const facts = { denied: new Map([[A1, false]]), names: new Map([[A1, '']]) };

    await resolveLineVatCode(CO, 'tx-1', line, 'bulk', facts);

    expect(resolveRuleVatCode).toHaveBeenCalledWith(expect.objectContaining({
      ruleGlAccountVatDenied: false,
      ruleGlAccountName: '',
    }));
    const { classifyNonSupplyAccount } =
      await import('@/modules/accounting/services/gl/nonSupplyAccounts');
    expect(classifyNonSupplyAccount(''), 'empty name classifies as nothing').toBeNull();
  });

  it('falls back when no prefetch was done at all — the single-tool path', async () => {
    await resolveLineVatCode(CO, 'tx-1', line, 'allocate_bank_transaction');

    expect(resolveRuleVatCode).toHaveBeenCalledWith(expect.objectContaining({
      ruleGlAccountVatDenied: undefined,
      ruleGlAccountName: undefined,
    }));
  });
});
