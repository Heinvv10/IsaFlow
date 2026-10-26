/**
 * budgetImportResolve (budgets P2 PR-B round 2), pure: SEC2-M1, a row key repeated many times is
 * grouped in one pass and each copy's error names a few other rows, not all of them (round 1 copied
 * the row list on every push and listed every other row: quadratic, 30 000 copies took tens of
 * seconds); VER-L6, codes that differ only by whitespace match exactly first.
 */
import { describe, it, expect } from 'vitest';
import { resolveLines } from '@/modules/accounting/services/budgets/budgetImportResolve';
import type { ImportLine } from '@/modules/accounting/services/budgets/budgetImportParse';
import type { GridAccount, GridReadModel } from '@/modules/accounting/services/budgets/gridReadTypes';

const account = (id: string, code: string): GridAccount => ({
  id, code, name: `Account ${code}`, type: 'revenue', subtype: null, band: 'turnover', isActive: true, parentId: null, depth: 0,
  isHeader: false, childIds: [], ownAmounts: false, grain: null, rollup: null,
});
const model = (accounts: GridAccount[]) => ({ accounts, dimensions: { cc1: [], cc2: [], bu: [] } }) as unknown as GridReadModel;
const line = (row: number, accountCode: string): ImportLine => ({ row, accountCode, dimensionCode: null, amounts: [{ month: '2026-03', cell: { kind: 'value', cents: row } }] });

describe('SEC2-M1: duplicates are grouped in linear time', () => {
  it('30 000 copies of one row: every copy an error, each naming three others, by the bounded message', () => {
    const lines = Array.from({ length: 30000 }, (_, i) => line(i + 2, '4000'));
    // No wall-clock bound (round 9): the message naming three others "and 29996 more" is what only
    // the one-pass grouping produces; round 1's listed every other row (and took ~50 s here).
    const out = resolveLines(model([account('a', '4000')]), 'company', lines, new Map());
    expect(out.rows).toEqual([]);
    expect(out.errors).toHaveLength(30000);
    expect(out.errors[0]!.message).toBe('4000 appears more than once (also on row 3, 4, 5 and 29996 more).');
  });
});

describe('VER-L6: exact before trimmed', () => {
  const twins = model([account('plain', '4000'), account('spaced', '4000 ')]);
  it('each twin keeps its own row', () => {
    const out = resolveLines(twins, 'company', [line(2, '4000'), line(3, '4000 ')], new Map());
    expect(out.errors).toEqual([]);
    expect(out.rows.map((r) => r.account.id)).toEqual(['plain', 'spaced']);
  });
  it('a code that only trims to them is ambiguous; one that trims to a single code matches it', () => {
    const out = resolveLines(twins, 'company', [line(2, ' 4000  ')], new Map());
    expect(out.errors[0]!.message).toMatch(/matches more than one account/);
    const single = resolveLines(model([account('spaced', '7000 ')]), 'company', [line(2, '7000')], new Map());
    expect(single.rows.map((r) => r.account.id)).toEqual(['spaced']);
  });
});
