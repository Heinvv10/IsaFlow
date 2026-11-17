/**
 * Review round 7 on the free-form budget sheet, the edges the LibreOffice fixtures do not reach: how a 2-decimal
 * format's shown value is computed (15 significant digits, half away from zero, never -0), a date header on the 1st
 * (a real date, not a misread "Mar-26"), and numeric codes in built-in Text (49).
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => []) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { roundToCents } from '@/modules/accounting/services/budgets/budgetFreeformAmounts';
import { freeformLines, type FreeCell } from '@/modules/accounting/services/budgets/budgetImportFreeform';
import { formatDecimals } from '@/modules/accounting/services/budgets/budgetFreeformFormats';
import { MONTHS, model } from '../../mcp/budgetToolsFixture';

describe('roundToCents: a value as a 2-decimal format draws it', () => {
  it.each([
    [1.005, 101], [2.675, 268], [-2.675, -268], [0.125, 13], [-0.005, -1], [100000 / 12, 833333], [5, 500], [0.1 + 0.2, 30],
    [123456789.125, 12345678913], [1e-7, 0], [-0.004, 0], [0.995, 100], [999.995, 100000],
  ])('%s shows as %s cents', (value, cents) => {
    expect(Object.is(roundToCents(value), cents)).toBe(true);
  });
});

describe('a date header on the 1st outside the year is the ordinary refusal; Text (49) is General', () => {
  const serial = (iso: string) => (Date.parse(`${iso}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86_400_000;
  const date = (iso: string): FreeCell => ({ kind: 'number', value: serial(iso), format: 'yyyy-mm-dd', plain: false, decimals: 0 });
  const text = (t: string): FreeCell => ({ kind: 'text', text: t, format: 'General', plain: true });

  it('2027-03-01 is "not a month of FY2027", with no misread-date advice', () => {
    const sheet = { name: 'Plan', rows: [{ row: 1, cells: [text('Code'), ...MONTHS.slice(0, 11).map((m) => text(m)), date('2027-03-01')] }] };
    expect(() => freeformLines(model(), 'company', sheet)).toThrow('Sheet "Plan", row 1, column M: "2027-03-01" is not a month of FY2027 (2026-03 to 2027-02).');
  });

  it('built-in 49 (@) shows a number as General does, so a numeric code in it is read', () => {
    expect(formatDecimals(49, undefined)).toBe(Infinity);
    const code: FreeCell = { kind: 'number', value: 6000, format: 'built-in 49', plain: true, decimals: formatDecimals(49, undefined)! };
    const sheet = { name: 'Plan', rows: [{ row: 1, cells: [text('Code'), ...MONTHS.map(text)] }, { row: 2, cells: [code, text('5')] }] };
    expect(freeformLines(model(), 'company', sheet).lines.map((l) => l.accountCode)).toEqual(['6000']);
  });
});
