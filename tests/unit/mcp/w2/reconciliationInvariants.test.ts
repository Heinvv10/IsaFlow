/**
 * What the reconciliation asserts about its OWN output.
 *
 * A residual of zero proves only that the items sum to the difference, never
 * that they are the right items — this endpoint reported 0.00 on every
 * production company while counting a VAT account as an AP control account,
 * because an item of the same amount across the same 356 documents removed it
 * again. These are the checks that do not close by construction, driven on
 * synthetic inputs so each one can be seen to go red.
 */
import { describe, it, expect } from 'vitest';
import { checkInvariants } from '@/modules/accounting/services/reconciliation/reconciliationInvariants';
import type { ReconcilingItem } from '@/modules/accounting/services/reconciliation/reconcilingItemTypes';

const item = (over: Partial<ReconcilingItem> = {}): ReconcilingItem => ({
  bridge: 'subledger_to_control',
  type: 'unapplied_receipt',
  description: 'unapplied',
  amount: 100,
  documentIds: ['p1'],
  documentNumbers: ['CP-1'],
  citedGross: 100,
  ...over,
});

const held = (out: ReturnType<typeof checkInvariants>, name: string) =>
  out.find((i) => i.name === name)!;

describe('checkInvariants', () => {
  it('reports all three, in a stable order', () => {
    const out = checkInvariants({
      subledgerTotal: 1100, controlAccountBalance: 1000, difference: 100,
      unexplained: 0, items: [item()],
    });
    expect(out.map((i) => i.name)).toEqual([
      'control_plus_items_equals_subledger',
      'item_within_cited_gross',
      'unexplained_is_the_residual',
    ]);
    expect(out.every((i) => i.holds)).toBe(true);
  });

  it('fails when the control balance plus the items does not reach the subledger', () => {
    const out = checkInvariants({
      subledgerTotal: 1100, controlAccountBalance: 1000, difference: 100,
      unexplained: 0, items: [item({ amount: 90 })],
    });
    expect(held(out, 'control_plus_items_equals_subledger').holds).toBe(false);
    expect(held(out, 'control_plus_items_equals_subledger').detail).toContain('1100');
  });

  it('fails when an item claims more than the documents it names are worth', () => {
    // The check that catches an item summed off the wrong column: +R453m of
    // document_not_on_control_account across bills worth a fraction of it.
    const out = checkInvariants({
      subledgerTotal: 1100, controlAccountBalance: 1000, difference: 100,
      unexplained: 0, items: [item({ amount: 100, citedGross: 40 })],
    });
    expect(held(out, 'item_within_cited_gross').holds).toBe(false);
    expect(held(out, 'item_within_cited_gross').detail).toContain('unapplied_receipt');
  });

  it('checks the ABSOLUTE amount, so an overstated negative item is caught too', () => {
    const out = checkInvariants({
      subledgerTotal: 900, controlAccountBalance: 1000, difference: -100,
      unexplained: 0, items: [item({ amount: -100, citedGross: 40 })],
    });
    expect(held(out, 'item_within_cited_gross').holds).toBe(false);
  });

  it('exempts the residual items, which cite no documents on purpose', () => {
    const out = checkInvariants({
      subledgerTotal: 1100, controlAccountBalance: 1000, difference: 100,
      unexplained: 100,
      items: [item({ type: 'unexplained_difference', amount: 100, documentIds: [], documentNumbers: [], citedGross: 0 })],
    });
    expect(held(out, 'item_within_cited_gross').holds).toBe(true);
  });

  it('tolerates a cent of rounding against the cited gross, and no more', () => {
    const ok = checkInvariants({
      subledgerTotal: 1100, controlAccountBalance: 1000, difference: 100,
      unexplained: 0, items: [item({ amount: 100.01, citedGross: 100 })],
    });
    expect(held(ok, 'item_within_cited_gross').holds).toBe(true);
    const bad = checkInvariants({
      subledgerTotal: 1100, controlAccountBalance: 1000, difference: 100,
      unexplained: 0, items: [item({ amount: 100.02, citedGross: 100 })],
    });
    expect(held(bad, 'item_within_cited_gross').holds).toBe(false);
  });

  it('fails when the residual has been clamped instead of reported', () => {
    // A clamped residual is how an incomplete decomposition comes to look
    // complete: the named items explain 90 of a difference of 100 and the
    // response claims nothing is left over.
    const out = checkInvariants({
      subledgerTotal: 1100, controlAccountBalance: 1000, difference: 100,
      unexplained: 0, items: [item({ amount: 90, citedGross: 90 })],
    });
    expect(held(out, 'unexplained_is_the_residual').holds).toBe(false);
    expect(held(out, 'unexplained_is_the_residual').detail).toContain('10');
  });

  it('holds when the residual is reported as an item AND as the figure', () => {
    const out = checkInvariants({
      subledgerTotal: 1100, controlAccountBalance: 1000, difference: 100,
      unexplained: 10,
      items: [
        item({ amount: 90, citedGross: 90 }),
        item({ type: 'unexplained_difference', amount: 10, documentIds: [], documentNumbers: [], citedGross: 0 }),
      ],
    });
    expect(out.every((i) => i.holds)).toBe(true);
  });

  it('ignores the aged bridge, which answers a different question', () => {
    // Adding the two bridges together produces a number that reconciles to
    // nothing exactly, so an aged item must not enter this arithmetic.
    const out = checkInvariants({
      subledgerTotal: 1100, controlAccountBalance: 1000, difference: 100,
      unexplained: 0,
      items: [item(), item({ bridge: 'aged_to_subledger', type: 'disputed_amount', amount: 5000, citedGross: 1 })],
    });
    expect(out.every((i) => i.holds)).toBe(true);
  });

  it('says NOT APPLICABLE rather than passing silently when there is no control account', () => {
    const out = checkInvariants({
      subledgerTotal: null, controlAccountBalance: null, difference: null,
      unexplained: null, items: [],
    });
    expect(out.every((i) => i.holds)).toBe(true);
    expect(held(out, 'control_plus_items_equals_subledger').detail).toContain('Not applicable');
  });
});
