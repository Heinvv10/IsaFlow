/**
 * Unit tests for bankRulesMatchingHelpers.buildAutoCreateLines.
 *
 * Locks in the auto-create JE shape for the four allocation paths:
 *   - account spent  : DR contra, CR bank
 *   - account deposit: DR bank, CR contra
 *   - supplier       : DR AP, CR bank (with optional VAT input)
 *   - customer       : DR bank, CR AR (with optional VAT output)
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({
  sql: Object.assign(vi.fn(), { unsafe: vi.fn() }),
  transaction: vi.fn(),
  withTransaction: vi.fn(),
}));

const { getSystemAccountIdMock } = vi.hoisted(() => ({
  getSystemAccountIdMock: vi.fn(),
}));

vi.mock('@/modules/accounting/services/gl/systemAccountResolver', () => ({
  getSystemAccountId: getSystemAccountIdMock,
}));

import { buildAutoCreateLines, toSqlPattern } from '@/modules/accounting/services/bank/bankRulesMatchingHelpers';

const BANK_GL = 'bank-gl-id';
const RULE_GL = 'rule-gl-id';
const AP = 'ap-control-id';
const AR = 'ar-control-id';
const VAT_INPUT = 'vat-input-id';
const VAT_OUTPUT = 'vat-output-id';

function baseArgs(overrides: Partial<Parameters<typeof buildAutoCreateLines>[0]> = {}) {
  return {
    allocType: 'account' as const,
    totalAmount: 100,
    netAmount: 100,
    vatAmount: 0,
    hasVat: false,
    vatAccountKey: 'vat_input' as const,
    vatType: undefined,
    isDeposit: false,
    bankGlAccountId: BANK_GL,
    ruleGlAccountId: RULE_GL,
    apAccountId: null,
    arAccountId: null,
    entryDesc: 'Test',
    companyId: 'co-1',
    ...overrides,
  };
}

describe('toSqlPattern', () => {
  it('wraps for contains', () => expect(toSqlPattern('contains', 'foo')).toBe('%foo%'));
  it('appends for starts_with', () => expect(toSqlPattern('starts_with', 'foo')).toBe('foo%'));
  it('prepends for ends_with', () => expect(toSqlPattern('ends_with', 'foo')).toBe('%foo'));
  it('exact returns pattern', () => expect(toSqlPattern('exact', 'foo')).toBe('foo'));
  it('unknown falls back to contains', () => expect(toSqlPattern('weird', 'foo')).toBe('%foo%'));
});

describe('buildAutoCreateLines — account', () => {
  it('spent: DR contra, CR bank', async () => {
    const lines = await buildAutoCreateLines(baseArgs({ isDeposit: false }));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ glAccountId: RULE_GL, debit: 100, credit: 0 });
    expect(lines[1]).toMatchObject({ glAccountId: BANK_GL, debit: 0, credit: 100 });
  });

  it('deposit: DR bank, CR contra', async () => {
    const lines = await buildAutoCreateLines(baseArgs({ isDeposit: true }));
    expect(lines[0]).toMatchObject({ glAccountId: BANK_GL, debit: 100, credit: 0 });
    expect(lines[1]).toMatchObject({ glAccountId: RULE_GL, debit: 0, credit: 100 });
  });

  it('spent with VAT: 3 lines, VAT debit on input', async () => {
    getSystemAccountIdMock.mockResolvedValue(VAT_INPUT);
    const lines = await buildAutoCreateLines(baseArgs({
      isDeposit: false, hasVat: true, totalAmount: 115, netAmount: 100, vatAmount: 15,
      vatAccountKey: 'vat_input', vatType: 'standard',
    }));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ glAccountId: RULE_GL, debit: 100 });
    expect(lines[1]).toMatchObject({ glAccountId: VAT_INPUT, debit: 15, credit: 0 });
    expect(lines[2]).toMatchObject({ glAccountId: BANK_GL, credit: 115 });
  });
});

describe('buildAutoCreateLines — supplier', () => {
  it('DR AP, CR bank (no VAT)', async () => {
    const lines = await buildAutoCreateLines(baseArgs({
      allocType: 'supplier', apAccountId: AP, isDeposit: false,
    }));
    expect(lines[0]).toMatchObject({ glAccountId: AP, debit: 100, credit: 0 });
    expect(lines[1]).toMatchObject({ glAccountId: BANK_GL, debit: 0, credit: 100 });
  });

  it('DR AP + VAT input, CR bank (with VAT)', async () => {
    getSystemAccountIdMock.mockResolvedValue(VAT_INPUT);
    const lines = await buildAutoCreateLines(baseArgs({
      allocType: 'supplier', apAccountId: AP, isDeposit: false,
      hasVat: true, totalAmount: 115, netAmount: 100, vatAmount: 15,
      vatAccountKey: 'vat_input', vatType: 'standard',
    }));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ glAccountId: AP, debit: 100 });
    expect(lines[1]).toMatchObject({ glAccountId: VAT_INPUT, debit: 15 });
    expect(lines[2]).toMatchObject({ glAccountId: BANK_GL, credit: 115 });
    const debits = lines.reduce((s: number, l) => s + l.debit, 0);
    const credits = lines.reduce((s: number, l) => s + l.credit, 0);
    expect(debits).toBeCloseTo(credits, 2);
  });
});

describe('buildAutoCreateLines — customer', () => {
  it('DR bank, CR AR (no VAT)', async () => {
    const lines = await buildAutoCreateLines(baseArgs({
      allocType: 'customer', arAccountId: AR, isDeposit: true,
    }));
    expect(lines[0]).toMatchObject({ glAccountId: BANK_GL, debit: 100, credit: 0 });
    expect(lines[1]).toMatchObject({ glAccountId: AR, debit: 0, credit: 100 });
  });

  it('DR bank, CR AR + VAT output (with VAT)', async () => {
    getSystemAccountIdMock.mockResolvedValue(VAT_OUTPUT);
    const lines = await buildAutoCreateLines(baseArgs({
      allocType: 'customer', arAccountId: AR, isDeposit: true,
      hasVat: true, totalAmount: 115, netAmount: 100, vatAmount: 15,
      vatAccountKey: 'vat_output', vatType: 'standard',
    }));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ glAccountId: BANK_GL, debit: 115 });
    expect(lines[1]).toMatchObject({ glAccountId: AR, credit: 100 });
    expect(lines[2]).toMatchObject({ glAccountId: VAT_OUTPUT, credit: 15 });
    const debits = lines.reduce((s: number, l) => s + l.debit, 0);
    const credits = lines.reduce((s: number, l) => s + l.credit, 0);
    expect(debits).toBeCloseTo(credits, 2);
  });
});
