/**
 * WP7 (admin audit 2026-11-14, 1.7 and 2.10): the platform invoice amounts the create route stores and the
 * page previews (15% VAT half up, total = subtotal + VAT), and the email a Send delivers (every figure in the
 * body, every database string escaped, one content row inside the card).
 */
import { describe, expect, it } from 'vitest';
import { Window } from 'happy-dom';
import { invoiceAmountsFromSubtotal } from '@/modules/admin/services/invoiceAmounts';
import { adminInvoiceEmail } from '@/modules/admin/services/adminInvoiceEmail';
import { isSingleEmailAddress } from '@/modules/admin/services/invoiceSendService';
import { formatMoney } from '@/lib/money/formatMoney';

describe('invoiceAmountsFromSubtotal', () => {
  it.each([
    [0, 0, 0],
    [10000, 1500, 11500],
    [10, 2, 12], // 1.5c rounds half up
    [3, 0, 3], // 0.45c rounds down
    [100001, 15000, 115001],
    [1_800_000_000, 270_000_000, 2_070_000_000], // the route's cap still fits the INT column
  ])('%i cents -> VAT %i, total %i', (subtotal, tax, total) => {
    expect(invoiceAmountsFromSubtotal(subtotal)).toEqual({ subtotal_cents: subtotal, tax_cents: tax, total_cents: total });
  });

  it.each([-1, 1.5, Number.NaN])('refuses %s', (bad) => {
    expect(() => invoiceAmountsFromSubtotal(bad)).toThrow(RangeError);
  });
});

describe('adminInvoiceEmail', () => {
  const base = {
    invoiceNumber: 'INV-202611-0007', companyName: 'Acme <b>Ltd</b> & Sons', issuedAt: new Date('2026-11-13T23:30:00Z'),
    dueDate: '2026-12-01', subtotalCents: 123456, taxCents: 18518, totalCents: 141974, notes: 'Line one\n<script>x()</script>',
  };

  it('carries the number, dates and every amount, and escapes the database strings', () => {
    const { subject, html } = adminInvoiceEmail(base);
    expect(subject).toBe('IsaFlow invoice INV-202611-0007');
    for (const text of ['INV-202611-0007', formatMoney(1234.56), formatMoney(185.18), formatMoney(1419.74), '14 Nov 2026', '01 Dec 2026']) {
      expect(html).toContain(text);
    }
    expect(html).toContain('Acme &lt;b&gt;Ltd&lt;/b&gt; &amp; Sons');
    expect(html).toContain('Line one<br>&lt;script&gt;x()&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<b>Ltd');
  });

  it('says "On receipt" with no due date and leaves out empty notes', () => {
    const { html } = adminInvoiceEmail({ ...base, dueDate: null, notes: '   ' });
    expect(html).toContain('On receipt');
    expect(html).not.toContain('Line one');
  });

  it('puts the content inside the card, after the logo', () => {
    const doc = new Window().document;
    doc.write(adminInvoiceEmail(base).html);
    const heading = doc.querySelector('h1');
    expect(heading?.textContent).toBe('INV-202611-0007');
    const logo = doc.querySelector('img');
    expect(logo && heading && (logo.compareDocumentPosition(heading) & 4)).toBeTruthy(); // DOCUMENT_POSITION_FOLLOWING
  });
});

describe('isSingleEmailAddress', () => {
  it.each([
    ['billing@acme.example.test', true],
    ['a@x.test, b@y.test', false],
    ['n/a', false],
    ['', false],
  ])('%s -> %s', (value, ok) => { expect(isSingleEmailAddress(value)).toBe(ok); });
});
