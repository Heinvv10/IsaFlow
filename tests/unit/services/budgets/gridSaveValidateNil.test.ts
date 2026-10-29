/**
 * validateBatch refuses the nil UUID as any id (round-3 verifier): gridSaveWrite matches cells with
 * each dimension COALESCEd to the nil UUID, so a cell naming it would match an undimensioned cell.
 */
import { describe, expect, it } from 'vitest';
import { validateBatch, type SaveCell } from '@/modules/accounting/services/budgets/gridSaveValidate';

const NIL = '00000000-0000-0000-0000-000000000000';
const ACCT = '3f6c1e1a-8a5b-4c1e-9d2f-1b2c3d4e5f60';
const base: SaveCell = { glAccountId: ACCT, cc1Id: null, cc2Id: null, buId: null, month: '2026-03', amount: 1 };
const refusal = (cells: SaveCell[]) => {
  try {
    validateBatch(cells);
    return 'accepted';
  } catch (err) {
    return `${(err as { code?: string }).code}: ${(err as Error).message}`;
  }
};

describe('validateBatch and the nil UUID', () => {
  it.each([
    ['glAccountId', { glAccountId: NIL }],
    ['cc1Id', { cc1Id: NIL }],
    ['cc2Id', { cc2Id: NIL }],
    ['buId', { buId: NIL }],
  ])('a nil %s is BUDGET_VERSION_INPUT naming it, as an upsert and as a clear', (field, patch) => {
    for (const cell of [{ ...base, ...patch }, { ...base, ...patch, amount: null, clear: true }]) {
      const out = refusal([cell]);
      expect(out).toMatch(/^BUDGET_VERSION_INPUT: /);
      expect(out).toContain(field);
    }
  });

  it('ordinary ids pass', () => {
    expect(refusal([{ ...base, cc1Id: '7d1e2f3a-4b5c-4d6e-8f70-819203a4b5c6' }])).toBe('accepted');
  });
});
