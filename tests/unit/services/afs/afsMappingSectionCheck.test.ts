/** The misplaced-account finding: "remap" advice split by direction. (An equity account on IS484 "Dividends paid" is not
 * misplaced: the SQL leaves it out, proved in tests/integration/afs-dividends-equity.int.test.ts.) */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sqlMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/neon', () => ({ sql: sqlMock }));

import { withStatementMappingFinding } from '@/modules/accounting/services/afs/afsMappingSectionCheck';

const TWICE = /revenue or expense account on a balance sheet line is counted twice/;
const STOCK = /asset, liability or equity account on an income statement line is a balance shown as a period movement and missing from the balance sheet/;
const row = (code: string, type: string, line: string, section: string) =>
  ({ account_code: code, account_name: `Acct ${code}`, account_type: type, afs_line_code: line, section });
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

  it('keeps the remap advice for a revenue account on a balance-sheet line', async () => {
    const f = await finding([revenueOnBs]);
    expect(f.detail).toMatch(/Remap each to a line of its own statement/);
    expect(f.detail).toMatch(TWICE);
    expect(f.detail).not.toMatch(STOCK);
  });

  it('says a stock on an income line is a balance shown as a period movement, not that it is counted twice', async () => {
    const f = await finding([loanOnIs, row('3200', 'equity', 'IS005', 'income_statement')]);
    expect(f.detail).toMatch(STOCK);
    expect(f.detail).toMatch(/Remap each/);
    expect(f.detail).not.toMatch(TWICE);
    expect(f.detail).not.toContain('Dividends paid');
  });

  it('does not state that the balance sheet will be out as a certainty', async () => {
    const f = await finding([revenueOnBs, loanOnIs]);
    expect(f.detail).not.toMatch(/won't balance|will not balance/);
  });

  it('gives each direction its own advice when both occur', async () => {
    const f = await finding([revenueOnBs, loanOnIs]);
    expect(f.detail).toMatch(TWICE);
    expect(f.detail).toMatch(STOCK);
  });

  it('names a non-equity account on IS484 with the remap advice', async () => {
    const f = await finding([row('2000', 'liability', 'IS484', 'income_statement')]);
    expect(f.detail).toMatch(STOCK);
    expect(f.detail).toMatch(/Remap each/);
    expect(f.detail).not.toContain('Dividends paid');
  });
});
