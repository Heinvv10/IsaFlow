/**
 * PR S round seven: which load the invoice page may show. Each rule on its own:
 * - a load for an invoice that is not the one open never starts;
 * - an answer is shown only for the invoice open when it lands, even with no newer load since;
 * - an answer is shown only if no newer load started since.
 */
import { describe, expect, it } from 'vitest';
import { openInvoiceLoads } from '@/components/invoices/openInvoiceLoads';

describe('openInvoiceLoads', () => {
  it('a load for an invoice that is not open never starts', () => {
    const loads = openInvoiceLoads();
    loads.open('B');
    expect(loads.begin('A')).toBeNull();
    expect(loads.begin('B')).not.toBeNull();
  });

  it('an answer for an invoice no longer open is dropped, with no newer load since', () => {
    const loads = openInvoiceLoads();
    loads.open('A');
    const token = loads.begin('A')!;
    loads.open('B');
    expect(loads.isCurrent(token)).toBe(false);
  });

  it('an answer overtaken by a newer load of the same invoice is dropped', () => {
    const loads = openInvoiceLoads();
    loads.open('A');
    const first = loads.begin('A')!;
    const second = loads.begin('A')!;
    expect(loads.isCurrent(first)).toBe(false);
    expect(loads.isCurrent(second)).toBe(true);
  });
});
