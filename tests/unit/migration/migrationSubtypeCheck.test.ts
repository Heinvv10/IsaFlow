// RED phase — written before implementation
/**
 * Unit tests for the go-live "account subtype coverage" check.
 *
 * The check exists because `account_subtype` is optional on import and every
 * subtype except `bank` fails silently: `aggregateFigures` DEFAULTS a NULL
 * subtype rather than leaving the money unbanded. On Velocity that put
 * R82,727,277.95 of direct cost below operating expenses and reported a 96.6%
 * gross margin against a real -1.9%.
 *
 * These tests exercise the pure banding/formatting half. Mutating
 * `buildSubtypeCoverageResult` to return a fixed 'pass' must turn them red —
 * a check that cannot fail is the defect class this codebase keeps finding.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

import {
  buildSubtypeCoverageResult,
  type UnclassifiedAccountRow,
} from '@/modules/accounting/services/core/migrationSubtypeCheck';

const row = (
  over: Partial<UnclassifiedAccountRow> & Pick<UnclassifiedAccountRow, 'balance'>,
): UnclassifiedAccountRow => ({
  account_code: '5000',
  account_name: 'Expenses',
  account_type: 'expense',
  ...over,
});

describe('buildSubtypeCoverageResult — when nothing is at risk', () => {
  it('passes when no account lacks a subtype', () => {
    const r = buildSubtypeCoverageResult([]);
    expect(r.status).toBe('pass');
    expect(r.check).toBe('Account Subtype Coverage');
  });

  it('passes when the only subtype-less accounts carry no posted movement', () => {
    const r = buildSubtypeCoverageResult([
      row({ account_code: '1000', account_name: 'Assets', account_type: 'asset', balance: 0 }),
      row({ account_code: '1100', account_name: 'Current Assets', account_type: 'asset', balance: '0.00' }),
    ]);
    expect(r.status).toBe('pass');
  });

  it('ignores sub-cent rounding dust', () => {
    expect(buildSubtypeCoverageResult([row({ balance: 0.004 })]).status).toBe('pass');
    expect(buildSubtypeCoverageResult([row({ balance: -0.004 })]).status).toBe('pass');
  });

  it('flags a balance of one cent', () => {
    expect(buildSubtypeCoverageResult([row({ balance: 0.01 })]).status).toBe('warn');
  });
});

describe('buildSubtypeCoverageResult — when value is unclassified', () => {
  it('warns rather than fails, so go-live is not blocked', () => {
    const r = buildSubtypeCoverageResult([row({ balance: 1000 })]);
    expect(r.status).toBe('warn');
  });

  it('counts only the accounts carrying value', () => {
    const r = buildSubtypeCoverageResult([
      row({ account_code: '5000', balance: 199836.49 }),
      row({ account_code: '1000', account_type: 'asset', balance: 0 }),
      row({ account_code: '4310', account_type: 'revenue', balance: -2876.63 }),
    ]);
    expect(r.message).toContain('2 account');
    expect(r.message).not.toContain('3 account');
  });

  it('totals the ABSOLUTE value, so a debit and a credit do not net to nothing', () => {
    const r = buildSubtypeCoverageResult([
      row({ account_code: '5000', balance: 1000 }),
      row({ account_code: '2215', account_type: 'liability', balance: -1000 }),
    ]);
    expect(r.status).toBe('warn');
    expect(r.message).toContain('R2,000.00');
  });

  it('reports the total with thousands separators and two decimals', () => {
    const r = buildSubtypeCoverageResult([row({ balance: 273434822.14 })]);
    expect(r.message).toContain('R273,434,822.14');
  });

  it('accepts the numeric strings pg returns for NUMERIC columns', () => {
    const r = buildSubtypeCoverageResult([row({ balance: '82727277.95' })]);
    expect(r.message).toContain('R82,727,277.95');
  });

  it('says what a NULL expense subtype COSTS, not just that it found one', () => {
    const r = buildSubtypeCoverageResult([row({ account_type: 'expense', balance: 82727277.95 })]);
    const text = `${r.message} ${r.detail ?? ''}`;
    expect(text).toMatch(/operating expense/i);
    expect(text).toMatch(/gross profit/i);
  });

  it('names the cost for asset, liability and revenue accounts too', () => {
    const asset = buildSubtypeCoverageResult([row({ account_type: 'asset', balance: 100 })]);
    expect(`${asset.message} ${asset.detail}`).toMatch(/current asset/i);

    const liability = buildSubtypeCoverageResult([row({ account_type: 'liability', balance: -100 })]);
    expect(`${liability.message} ${liability.detail}`).toMatch(/current liabilit/i);

    const revenue = buildSubtypeCoverageResult([row({ account_type: 'revenue', balance: -100 })]);
    expect(`${revenue.message} ${revenue.detail}`).toMatch(/other income|turnover|revenue/i);
  });

  it('names the largest accounts in detail, biggest first', () => {
    const r = buildSubtypeCoverageResult([
      row({ account_code: '49784353', account_name: 'Casual wages', balance: 2327887.5 }),
      row({ account_code: '49784351', account_name: 'Direct Material', balance: 46923976.23 }),
      row({ account_code: '49784352', account_name: 'Sub-Contractors', balance: 31542856.94 }),
    ]);
    const detail = r.detail ?? '';
    expect(detail).toContain('49784351');
    expect(detail).toContain('Direct Material');
    expect(detail.indexOf('49784351')).toBeLessThan(detail.indexOf('49784352'));
    expect(detail.indexOf('49784352')).toBeLessThan(detail.indexOf('49784353'));
  });

  it('ranks by absolute value, so a large credit outranks a small debit', () => {
    const r = buildSubtypeCoverageResult([
      row({ account_code: 'SMALL', balance: 5 }),
      row({ account_code: 'BIG', account_type: 'liability', balance: -2929402.12 }),
    ]);
    expect((r.detail ?? '').indexOf('BIG')).toBeLessThan((r.detail ?? '').indexOf('SMALL'));
  });

  it('does not name every account when there are many, but says how many are unnamed', () => {
    const many = Array.from({ length: 51 }, (_, i) =>
      row({ account_code: `A${i}`, account_name: `Account ${i}`, balance: 1000 - i }),
    );
    const r = buildSubtypeCoverageResult(many);
    expect(r.message).toContain('51 account');
    expect(r.detail).toContain('A0');
    expect(r.detail).not.toContain('A50');
    expect(r.detail).toMatch(/46 (more|further)/i);
  });
});
