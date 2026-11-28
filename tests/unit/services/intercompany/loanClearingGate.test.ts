/**
 * The dark flag `intercompany_loan_clearing`'s one gate: `hasFeature` once per call (override, then global, then plan), in a savepoint of its
 * own so a failed read cannot poison the caller's transaction (a payment, an accept). FAIL CLOSED: an error answers false and is logged with
 * the SQLSTATE only (never the database's text, which can name ids).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  hasFeature: vi.fn(async (_c: string, _f: string) => true as unknown),
  savepoint: vi.fn(async (_n: string, fn: () => Promise<unknown>) => fn()),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/modules/admin/services/featureFlagService', () => ({ hasFeature: m.hasFeature }));
vi.mock('@/lib/neon', () => ({ withSavepoint: m.savepoint, sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: m.log }));

import {
  LOAN_CLEARING_FEATURE, LOAN_CLEARING_OFF, LoanClearingNotEnabled, loanClearingEnabled,
} from '@/modules/accounting/services/intercompany/loanClearingGate';
import { ConnectionRefusal } from '@/modules/accounting/services/intercompany/connectionTypes';

const CO = 'c0000000-0000-4000-8000-000000000001';
beforeEach(() => { vi.clearAllMocks(); m.hasFeature.mockResolvedValue(true); });

describe('loanClearingEnabled', () => {
  it('asks hasFeature once, for this company and the flag code, in its own savepoint', async () => {
    expect(LOAN_CLEARING_FEATURE).toBe('intercompany_loan_clearing');
    expect(await loanClearingEnabled(CO)).toBe(true);
    expect(m.hasFeature.mock.calls).toEqual([[CO, 'intercompany_loan_clearing']]);
    expect(m.savepoint).toHaveBeenCalledTimes(1);
  });

  it('off is off', async () => {
    m.hasFeature.mockResolvedValue(false);
    expect(await loanClearingEnabled(CO)).toBe(false);
  });

  it('fails closed: an error answers false, logged at WARN by SQLSTATE only', async () => {
    m.hasFeature.mockRejectedValue(Object.assign(new Error('permission denied for table feature_flags (id 123)'), { code: '42501' }));
    expect(await loanClearingEnabled(CO)).toBe(false);
    expect(m.log.warn).toHaveBeenCalledWith(expect.stringMatching(/loan clearing/i), { companyId: CO, code: '42501' }, 'intercompany');
    expect(JSON.stringify(m.log.warn.mock.calls)).not.toMatch(/permission denied|123/);
  });

  it('an error without a SQLSTATE (a failed savepoint, a thrown non-error) is off too', async () => {
    m.savepoint.mockRejectedValueOnce('boom');
    expect(await loanClearingEnabled(CO)).toBe(false);
    expect(m.log.warn).toHaveBeenCalledWith(expect.any(String), { companyId: CO, code: null }, 'intercompany');
  });

  it('only a real true is on (a truthy non-boolean is not)', async () => {
    m.hasFeature.mockResolvedValue('yes');
    expect(await loanClearingEnabled(CO)).toBe(false);
  });
});

describe('LoanClearingNotEnabled', () => {
  it('is a 403 refusal with the code not_enabled and a plain sentence (the routes answer it as any refusal)', () => {
    const e = new LoanClearingNotEnabled();
    expect(e).toBeInstanceOf(ConnectionRefusal);
    expect(e).toMatchObject({ status: 403, code: 'not_enabled', message: LOAN_CLEARING_OFF });
    expect(LOAN_CLEARING_OFF).toBe('Clearing intercompany payments against the loan account is not enabled for this company.');
  });
});
