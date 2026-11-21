/**
 * taxModeSwitch (#1701 round 8 items 2-4), pure: each line at its own rate, a switch that moves a line refused, a company
 * not registered for VAT converts nothing and is offered No VAT only; and an ordinary one-unit price never refuses.
 */
import { describe, expect, it } from 'vitest';
import { switchTaxMode, taxModesFor } from '@/components/accounting/customer-invoices/taxModeSwitch';

const D = '2026-09-15';
const base = { formRate: 15, date: D, registered: true };

describe('switchTaxMode', () => {
  it('a mixed draft converts each line at its own rate (exempt unchanged)', () => {
    const lines = [{ description: 'S', quantity: 1, unitPrice: 100, vatType: 'standard', vatRateAtLoad: 15 },
      { description: 'E', quantity: 1, unitPrice: 100, vatType: 'exempt', vatRateAtLoad: 15 }];
    const out = switchTaxMode(lines, { ...base, from: 'exclusive', to: 'inclusive' });
    expect('lines' in out && out.lines.map((l) => l.unitPrice)).toEqual([115, 100]);
  });
  it('1,000 x R0.03 to inclusive is refused, naming both totals', () => {
    expect(switchTaxMode([{ description: 'Tiny', quantity: 1000, unitPrice: 0.03 }], { ...base, from: 'exclusive', to: 'inclusive' }))
      .toEqual({ problem: expect.stringMatching(/^Switching to Including VAT would change "Tiny" from R\s?34\.50 to R\s?30\.00/) });
  });
  it('not registered: nothing converts and the mode is No VAT; only No VAT is offered', () => {
    expect(switchTaxMode([{ quantity: 1, unitPrice: 100 }], { ...base, registered: false, from: 'none', to: 'inclusive' }))
      .toEqual({ mode: 'none', lines: [{ quantity: 1, unitPrice: 100 }] });
    expect(taxModesFor(false).map((o) => o.value)).toEqual(['none']);
    expect(taxModesFor(true).map((o) => o.value)).toEqual(['exclusive', 'inclusive', 'none']);
  });
  it('No VAT to Including VAT keeps the net (the VAT is added by design)', () => {
    const out = switchTaxMode([{ quantity: 1, unitPrice: 100 }], { ...base, from: 'none', to: 'inclusive' });
    expect('lines' in out && out.lines[0]!.unitPrice).toBe(115);
  });
  it('seeded, one unit: excl. to incl. never refuses; incl. to excl. refuses only where no ex-VAT price gives that gross', () => {
    // Excluding VAT can only show a gross p + round(15% of p): some grosses (5,553.92: 4,829.49 gives 5,553.91, 4,829.50
    // gives 5,553.93) have no such p, so that switch would move the total a cent, and is refused.
    expect(switchTaxMode([{ description: 'G', quantity: 1, unitPrice: 5553.92 }], { ...base, from: 'inclusive', to: 'exclusive' }))
      .toEqual({ problem: expect.stringMatching(/from R\s?5\s?553\.92 to R\s?5\s?553\.93/) });
    const grossOf = (pc: number) => pc + Math.round(pc * 0.15);
    let seed = 8;
    for (let i = 0; i < 2000; i++) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      const p = (seed % 10_000_000) / 100;
      expect('lines' in switchTaxMode([{ quantity: 1, unitPrice: p }], { ...base, from: 'exclusive', to: 'inclusive' }), `${p}`).toBe(true);
      const refused = !('lines' in switchTaxMode([{ quantity: 1, unitPrice: p }], { ...base, from: 'inclusive', to: 'exclusive' }));
      const g = Math.round(p * 100);
      const guess = Math.round(g / 1.15);
      const expressible = [guess - 1, guess, guess + 1].some((pc) => grossOf(pc) === g);
      expect(refused, `${p}`).toBe(!expressible);
    }
  });
  it('a form rate below 0 or mid-edit converts nothing: prices kept, the mode changes', () => {
    for (const formRate of [-5, Number.NaN]) {
      expect(switchTaxMode([{ quantity: 1, unitPrice: 100 }], { ...base, formRate, from: 'exclusive', to: 'inclusive' }))
        .toEqual({ mode: 'inclusive', lines: [{ quantity: 1, unitPrice: 100 }] });
    }
  });
  it('round 11 nit a: a standard line converts at the standard rate ON THE INVOICE DATE (14% before April 2018), not the form\'s', () => {
    const out = switchTaxMode([{ description: 'S', quantity: 1, unitPrice: 100, vatType: 'standard', vatRateAtLoad: 15 }],
      { ...base, date: '2018-03-01', from: 'exclusive', to: 'inclusive' });
    expect('lines' in out && out.lines[0]!.unitPrice).toBe(114);
  });
  it('round 11 nit a: the refusal names the amounts in the invoice\'s currency', () => {
    expect(switchTaxMode([{ description: 'Tiny', quantity: 1000, unitPrice: 0.03 }], { ...base, currencyCode: 'USD', from: 'exclusive', to: 'inclusive' }))
      .toEqual({ problem: expect.stringMatching(/from \$\s?34\.50 to \$\s?30\.00/) });
  });
});
