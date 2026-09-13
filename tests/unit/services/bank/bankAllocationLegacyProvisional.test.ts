/**
 * The contra comparison that authorises reversing a provisional entry which PREDATES the controls.
 *
 * It exists because `matchesBankAllocationJournalLines` also demands `cost_center_id = cc1_id`, a convention the
 * controlled writer keeps and the OLD provisional poster did not (it wrote a predicted `cost_center_id` with `cc1_id`
 * null). Holding a legacy contra to the new writer's convention would refuse exactly the entries this path exists to
 * reverse — so this compares against what the original journal actually carries, and admits nothing else.
 *
 * Pure, and therefore the layer CI enforces: `bun run ci` gates test:integration on DATABASE_URL, so the end-to-end
 * proof of this path (tests/integration/controls/provisionalControl.int.test.ts) does not run there.
 */
import { describe, it, expect } from 'vitest';
import { isLegacyProvisionalContra } from '@/modules/accounting/services/bank/bankAllocationLegacyProvisional';

const expense = '11111111-1111-4111-8111-111111111111';
const vat = '22222222-2222-4222-8222-222222222222';
const bank = '33333333-3333-4333-8333-333333333333';
const centre = '44444444-4444-4444-8444-444444444444';

type Line = Record<string, unknown>;
/** The shape loadLegacyProvisionalOriginal returns: money as text, dimensions as read. */
function line(over: Partial<Line> = {}): Line {
  return { id: 'l1', gl_account_id: expense, debit: '100.00', credit: '0.00', vat_type: null,
    cost_center_id: null, cc1_id: null, cc2_id: null, bu_id: null, ...over };
}
/** What reverseJournalEntry writes: the same rows with debit and credit swapped, dimensions copied as they were. */
function mirror(lines: Line[]): Line[] {
  return lines.map((l) => ({ ...l, debit: l.credit, credit: l.debit }));
}
const original = (lines: Line[]) => ({ journal: {}, lines, bank: {}, bankLine: lines[0]! } as Parameters<typeof isLegacyProvisionalContra>[0]);

describe('isLegacyProvisionalContra', () => {
  it('accepts the exact mirror of a VAT-bearing provisional journal', () => {
    const lines = [
      line({ debit: '100.00', vat_type: 'standard' }),
      line({ id: 'l2', gl_account_id: vat, debit: '15.00', vat_type: 'standard' }),
      line({ id: 'l3', gl_account_id: bank, debit: '0.00', credit: '115.00' }),
    ];
    expect(isLegacyProvisionalContra(original(lines), mirror(lines))).toBe(true);
  });

  it('accepts a contra whose cost_center_id and cc1_id disagree — the old poster\'s own convention', () => {
    // THE point of this function. The shared matcher rejects this outright, which would make every pre-controls entry
    // carrying a predicted cost centre permanently un-dismissable.
    const lines = [line({ cost_center_id: centre, cc1_id: null }), line({ id: 'l2', gl_account_id: bank, debit: '0.00', credit: '100.00' })];
    expect(isLegacyProvisionalContra(original(lines), mirror(lines))).toBe(true);
  });

  it('accepts the mirror in any row order, since the contra is copied by a SELECT', () => {
    const lines = [line(), line({ id: 'l2', gl_account_id: bank, debit: '0.00', credit: '100.00' })];
    expect(isLegacyProvisionalContra(original(lines), mirror(lines).reverse())).toBe(true);
  });

  it('reads money by value, not by spelling', () => {
    const lines = [line({ debit: '100.00' }), line({ id: 'l2', gl_account_id: bank, debit: '0.00', credit: '100.00' })];
    const contra = mirror(lines).map((l) => ({ ...l, debit: String(Number(l.debit)), credit: String(Number(l.credit)) }));
    expect(isLegacyProvisionalContra(original(lines), contra)).toBe(true);
  });

  it.each([
    ['a different account', (c: Line[]) => [{ ...c[0]!, gl_account_id: vat }, c[1]!]],
    ['a different amount', (c: Line[]) => [{ ...c[0]!, credit: '100.01' }, c[1]!]],
    ['a VAT classification the original did not carry', (c: Line[]) => [{ ...c[0]!, vat_type: 'standard' }, c[1]!]],
    ['a dimension the original did not carry', (c: Line[]) => [{ ...c[0]!, cc1_id: centre }, c[1]!]],
    ['a business unit the original did not carry', (c: Line[]) => [{ ...c[0]!, bu_id: centre }, c[1]!]],
    ['lines NOT mirrored — the same direction as the original', (c: Line[]) => mirror(c)],
    ['a dropped line', (c: Line[]) => [c[0]!]],
    ['an extra line', (c: Line[]) => [...c, c[0]!]],
  ])('refuses %s', (_label, mutate) => {
    const lines = [line(), line({ id: 'l2', gl_account_id: bank, debit: '0.00', credit: '100.00' })];
    expect(isLegacyProvisionalContra(original(lines), mutate(mirror(lines)))).toBe(false);
  });
});
