/**
 * The guard that should have stopped R400,388.14 — and then R237,021.60 when
 * the same import ran again.
 *
 * Velocity `49784360 Salaries & Wages` was allocated VAT-exclusive 29 times,
 * every payment split 15% to VAT Input. The ledger was rebuilt on 2026-09-05
 * and it happened again: 34 lines, R237,021.60. Nothing at posting time knew
 * a salary is not a supply.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { log } from '@/lib/logger';
import {
  NON_SUPPLY_ADVICE,
  applyNonSupplyGuard,
  shouldWarnOnNonSupply,
} from '@/modules/accounting/services/gl/nonSupplyVatGuard';

beforeEach(() => vi.clearAllMocks());

describe('shouldWarnOnNonSupply — the attended paths', () => {
  it('warns on the exact account that produced the defect', () => {
    expect(shouldWarnOnNonSupply('Salaries & Wages - EX4000', 'standard'))
      .toBe('employment_cost');
  });

  it('warns on an output-side claim too', () => {
    expect(shouldWarnOnNonSupply('Investment - Blitz Fibre (Pty) Ltd', 'standard'))
      .toBe('financial_service');
  });

  it('warns on zero_rated — that still declares a supply value in box 2', () => {
    expect(shouldWarnOnNonSupply('Salaries & Wages', 'zero_rated')).toBe('employment_cost');
  });

  it('stays silent when nothing is being claimed', () => {
    expect(shouldWarnOnNonSupply('Salaries & Wages', 'none')).toBeNull();
    expect(shouldWarnOnNonSupply('Salaries & Wages', 'no_vat')).toBeNull();
    expect(shouldWarnOnNonSupply('Salaries & Wages', undefined)).toBeNull();
  });

  it('stays silent on exempt — correct for interest, and harmless elsewhere', () => {
    expect(shouldWarnOnNonSupply('Interest Received', 'exempt')).toBeNull();
  });

  it('stays silent on a real supply', () => {
    expect(shouldWarnOnNonSupply('Bank Charges - EX5006', 'standard')).toBeNull();
    expect(shouldWarnOnNonSupply('Travelling & Accommodation - EX5046', 'standard')).toBeNull();
  });

  it('stays silent when there is no account name to judge', () => {
    expect(shouldWarnOnNonSupply('', 'standard')).toBeNull();
    expect(shouldWarnOnNonSupply(null, 'standard')).toBeNull();
  });
});

describe('applyNonSupplyGuard — the unattended paths', () => {
  const ctx = { companyId: 'c1', bankTxId: 'tx1', ruleName: 'Salary run' };

  it('coerces a salary claim to none and says so', () => {
    const r = applyNonSupplyGuard('Salaries & Wages - EX4000', 'standard', ctx);
    expect(r).toEqual({ vatCode: 'none', coerced: true, reason: 'employment_cost' });
  });

  it('logs the coercion with the account and the reason', () => {
    applyNonSupplyGuard('Salaries & Wages - EX4000', 'standard', ctx);
    expect(vi.mocked(log.warn)).toHaveBeenCalledTimes(1);
    const [message, data] = vi.mocked(log.warn).mock.calls[0]!;
    expect(message).toContain('no supply');
    expect(data).toMatchObject({
      accountName: 'Salaries & Wages - EX4000',
      reason: 'employment_cost',
      requestedVatCode: 'standard',
      companyId: 'c1',
    });
  });

  it('leaves a real supply alone and logs nothing', () => {
    const r = applyNonSupplyGuard('Bank Charges - EX5006', 'standard', ctx);
    expect(r).toEqual({ vatCode: 'standard', coerced: false, reason: null });
    expect(vi.mocked(log.warn)).not.toHaveBeenCalled();
  });

  it('leaves a non-claiming code alone even on a non-supply account', () => {
    const r = applyNonSupplyGuard('Salaries & Wages', 'exempt', ctx);
    expect(r).toEqual({ vatCode: 'exempt', coerced: false, reason: null });
    expect(vi.mocked(log.warn)).not.toHaveBeenCalled();
  });

  it('defaults a missing code to none without claiming a coercion', () => {
    const r = applyNonSupplyGuard('Salaries & Wages', undefined, ctx);
    expect(r).toEqual({ vatCode: 'none', coerced: false, reason: null });
  });
});

describe('NON_SUPPLY_ADVICE', () => {
  it('names the statute the reader needs, not just the verdict', () => {
    expect(NON_SUPPLY_ADVICE.employment_cost).toMatch(/not a supply/i);
    expect(NON_SUPPLY_ADVICE.financial_service).toMatch(/exempt/i);
    // Every reason has copy — a new category without one renders blank.
    for (const reason of ['employment_cost', 'tax_or_penalty', 'distribution',
      'depreciation', 'donation', 'financial_service'] as const) {
      expect(NON_SUPPLY_ADVICE[reason].length).toBeGreaterThan(20);
    }
  });
});

describe('the labels and advice cover every reason', () => {
  it('has a label for each, so the screen never renders a blank warning', async () => {
    const { NON_SUPPLY_LABEL, NON_SUPPLY_PATTERNS } =
      await import('@/modules/accounting/services/gl/nonSupplyAccounts');
    for (const { reason } of NON_SUPPLY_PATTERNS) {
      expect(NON_SUPPLY_LABEL[reason]).toBeTruthy();
      expect(NON_SUPPLY_ADVICE[reason]).toBeTruthy();
    }
  });
});

describe('the pure module stays importable from the browser', () => {
  it('resolves without pulling in a database client, transitively', async () => {
    // The bank screens import this directly, so a server-only import anywhere
    // in its graph breaks the page bundle. Asserted by making those modules
    // throw on import and requiring this one to load anyway — a source-text
    // grep would pass a differently-spelled import, or an indirection through
    // a helper that pulls the client in itself.
    vi.resetModules();
    vi.doMock('@/lib/neon', () => { throw new Error('db client imported'); });
    vi.doMock('@/lib/logger', () => { throw new Error('server logger imported'); });
    const mod = await import('@/modules/accounting/services/gl/nonSupplyAccounts');
    expect(typeof mod.classifyNonSupplyAccount).toBe('function');
    vi.doUnmock('@/lib/neon');
    vi.doUnmock('@/lib/logger');
    vi.resetModules();
  });
});
