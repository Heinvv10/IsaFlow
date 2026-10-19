/** The misplaced-account finding: an equity account on IS484 "Dividends paid" gets its own advice, others keep "remap". */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sqlMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/neon', () => ({ sql: sqlMock }));

import { withStatementMappingFinding } from '@/modules/accounting/services/afs/afsMappingSectionCheck';

const DIVIDENDS_ADVICE = "Dividends paid is shown on the income statement; this version doesn't yet carry it into "
  + "balance-sheet equity, so the balance sheet won't balance.";
const row = (code: string, type: string, line: string, section: string) =>
  ({ account_code: code, account_name: `Acct ${code}`, account_type: type, afs_line_code: line, section });
const dividends = row('3500', 'equity', 'IS484', 'income_statement');
const revenueOnBs = row('4000', 'revenue', 'BS046', 'balance_sheet');
const loanOnIs = row('2000', 'liability', 'IS002', 'income_statement');

async function finding(rows: unknown[]) {
  sqlMock.mockResolvedValueOnce(rows);
  const out = await withStatementMappingFinding([], 'c', true);
  return out[0];
}

beforeEach(() => sqlMock.mockReset());

describe('withStatementMappingFinding', () => {
  it('adds nothing when no account is misplaced, and does not query for a non-AFS document', async () => {
    sqlMock.mockResolvedValueOnce([]);
    expect(await withStatementMappingFinding([], 'c', true)).toEqual([]);
    sqlMock.mockClear();
    expect(await withStatementMappingFinding([], 'c', false)).toEqual([]);
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it('gives an equity account on IS484 the dividends advice and no remap advice', async () => {
    const f = await finding([dividends]);
    expect(f.detail).toContain('3500 Acct 3500 (equity) is mapped to IS484, an income statement line');
    expect(f.detail).toContain(DIVIDENDS_ADVICE);
    expect(f.detail).not.toMatch(/[Rr]emap/);
  });

  it('keeps the remap advice for a revenue account on a balance-sheet line', async () => {
    const f = await finding([revenueOnBs]);
    expect(f.detail).toMatch(/Remap each to a line of its own statement/);
    expect(f.detail).not.toContain('Dividends paid');
  });

  it('keeps the remap advice for a non-dividend equity-or-liability account on an income line', async () => {
    const f = await finding([loanOnIs, row('3200', 'equity', 'IS005', 'income_statement')]);
    expect(f.detail).toMatch(/Remap each/);
    expect(f.detail).not.toContain('Dividends paid');
  });

  it('gives each its own advice when both occur', async () => {
    const f = await finding([dividends, revenueOnBs]);
    expect(f.detail).toContain(DIVIDENDS_ADVICE);
    expect(f.detail).toMatch(/Remap each/);
  });

  it('does not give the dividends advice to a non-equity account on IS484', async () => {
    const f = await finding([row('2000', 'liability', 'IS484', 'income_statement')]);
    expect(f.detail).toMatch(/Remap each/);
    expect(f.detail).not.toContain('Dividends paid');
  });
});
