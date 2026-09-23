import { describe, it, expect } from 'vitest';
import {
  buildInvoiceHref,
  parseReturnContext,
  buildInvoiceTrail,
} from '@/components/accounting/invoiceReturnContext';

const CUSTOMER = '3f8a1c2e-1b2c-4d5e-8f90-a1b2c3d4e5f6';
const SUPPLIER = '9e8d7c6b-5a49-4382-9716-05f4e3d2c1b0';
const INVOICE = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

/** Parse a built href the way Next's router would hand the query to a page. */
function queryOf(href: string): Record<string, string> {
  const url = new URL(href, 'http://app.test');
  return Object.fromEntries(url.searchParams.entries());
}

describe('buildInvoiceHref', () => {
  it('links a debtors row to the customer invoice with its customer', () => {
    expect(buildInvoiceHref(INVOICE, { from: 'debtors', entityId: CUSTOMER }))
      .toBe(`/accounting/customer-invoices/${INVOICE}?from=debtors&customer=${CUSTOMER}`);
  });

  it('links an AP aging row to the supplier invoice with supplier and as-at date', () => {
    expect(buildInvoiceHref(INVOICE, { from: 'ap-aging', entityId: SUPPLIER, asAtDate: '2026-08-31' }))
      .toBe(`/accounting/supplier-invoices/${INVOICE}?from=ap-aging&supplier=${SUPPLIER}&as_at_date=2026-08-31`);
  });

  it('drops an as-at date the source does not keep, and malformed values', () => {
    expect(buildInvoiceHref(INVOICE, { from: 'debtors', entityId: 'not-a-uuid', asAtDate: '2026-08-31' }))
      .toBe(`/accounting/customer-invoices/${INVOICE}?from=debtors`);
    expect(buildInvoiceHref(INVOICE, { from: 'ar-aging', entityId: CUSTOMER, asAtDate: '31/08/2026' }))
      .toBe(`/accounting/customer-invoices/${INVOICE}?from=ar-aging&customer=${CUSTOMER}`);
  });

  it('encodes the invoice id so it cannot escape the path', () => {
    expect(buildInvoiceHref('../x?y', { from: 'debtors' }))
      .toBe('/accounting/customer-invoices/..%2Fx%3Fy?from=debtors');
  });
});

describe('parseReturnContext', () => {
  it('round-trips each aging source back to the view it came from', () => {
    const debtors = queryOf(buildInvoiceHref(INVOICE, { from: 'debtors', entityId: CUSTOMER }));
    expect(parseReturnContext(debtors, 'customer'))
      .toEqual({ label: 'Debtors Manager', href: `/accounting/debtors-manager?customer=${CUSTOMER}` });

    const ar = queryOf(buildInvoiceHref(INVOICE, { from: 'ar-aging', entityId: CUSTOMER, asAtDate: '2026-06-30' }));
    expect(parseReturnContext(ar, 'customer'))
      .toEqual({ label: 'AR Aging', href: `/accounting/ar-aging?customer=${CUSTOMER}&as_at_date=2026-06-30` });

    const ap = queryOf(buildInvoiceHref(INVOICE, { from: 'ap-aging', entityId: SUPPLIER, asAtDate: '2026-06-30' }));
    expect(parseReturnContext(ap, 'supplier'))
      .toEqual({ label: 'AP Aging', href: `/accounting/ap-aging?supplier=${SUPPLIER}&as_at_date=2026-06-30` });
  });

  it('returns null for an absent or unknown from', () => {
    expect(parseReturnContext({}, 'customer')).toBeNull();
    expect(parseReturnContext({ from: 'creditors' }, 'supplier')).toBeNull();
    expect(parseReturnContext({ from: ['debtors', 'ap-aging'] }, 'customer')).toBeNull();
    expect(parseReturnContext({ from: 'toString' }, 'customer')).toBeNull();
  });

  it('returns null when from belongs to the other ledger', () => {
    expect(parseReturnContext({ from: 'ap-aging', supplier: SUPPLIER }, 'customer')).toBeNull();
    expect(parseReturnContext({ from: 'debtors', customer: CUSTOMER }, 'supplier')).toBeNull();
  });

  it('keeps the source view but drops missing or malformed restore params', () => {
    expect(parseReturnContext({ from: 'debtors' }, 'customer'))
      .toEqual({ label: 'Debtors Manager', href: '/accounting/debtors-manager' });
    expect(parseReturnContext({ from: 'ap-aging', supplier: 'x&from=evil', as_at_date: 'today' }, 'supplier'))
      .toEqual({ label: 'AP Aging', href: '/accounting/ap-aging' });
  });

  it('never produces an off-site href from a hostile query', () => {
    const hostile = ['//evil.com', 'https://evil.com', '/\\evil.com', 'javascript:alert(1)'];
    for (const from of hostile) {
      expect(parseReturnContext({ from }, 'customer')).toBeNull();
      const { back, items } = buildInvoiceTrail('customer', { from, customer: '//evil.com' }, 'X', 'INV1');
      for (const href of [back.href, ...items.map(i => i.href)]) {
        if (href === undefined) continue;
        expect(href.startsWith('/accounting')).toBe(true);
        expect(href.startsWith('//')).toBe(false);
      }
    }
  });
});

describe('buildInvoiceTrail', () => {
  it('reads Accounting › Debtors Manager › <Customer> › <INV#> from debtors', () => {
    const { items, back } = buildInvoiceTrail('customer', { from: 'debtors', customer: CUSTOMER }, 'Herotel', 'INV0000387');
    expect(items.map(i => i.label)).toEqual(['Accounting', 'Debtors Manager', 'Herotel', 'INV0000387']);
    expect(items[1]!.href).toBe(`/accounting/debtors-manager?customer=${CUSTOMER}`);
    expect(back.href).toBe(items[2]!.href);
    expect(items[3]!.href).toBeUndefined();
  });

  it('reads Accounting › AP Aging › <Supplier> › <INV#> from AP aging', () => {
    const { items, back } = buildInvoiceTrail('supplier', { from: 'ap-aging', supplier: SUPPLIER }, 'Acme', 'SI-9');
    expect(items.map(i => i.label)).toEqual(['Accounting', 'AP Aging', 'Acme', 'SI-9']);
    expect(back).toEqual({ label: 'AP Aging', href: `/accounting/ap-aging?supplier=${SUPPLIER}` });
  });

  it('falls back to the invoice list for no or unknown from', () => {
    const customer = buildInvoiceTrail('customer', { from: '//evil.com' }, 'Herotel', 'INV1');
    expect(customer.items.map(i => i.label)).toEqual(['Accounting', 'Invoices', 'INV1']);
    expect(customer.back).toEqual({ label: 'Invoices', href: '/accounting/customer-invoices' });

    const supplier = buildInvoiceTrail('supplier', {}, 'Acme', 'SI-9');
    expect(supplier.items.map(i => i.label)).toEqual(['Accounting', 'Supplier Invoices', 'SI-9']);
    expect(supplier.back).toEqual({ label: 'Supplier Invoices', href: '/accounting/supplier-invoices' });
  });

  it('omits the entity crumb when the name is not known yet', () => {
    const { items } = buildInvoiceTrail('customer', { from: 'debtors', customer: CUSTOMER }, undefined, 'INV1');
    expect(items.map(i => i.label)).toEqual(['Accounting', 'Debtors Manager', 'INV1']);
  });

  it('keeps the Back link equal to the crumb before the invoice number in every shape', () => {
    const queries = [{}, { from: 'debtors' }, { from: 'debtors', customer: CUSTOMER }, { from: 'ar-aging', customer: CUSTOMER, as_at_date: '2026-01-31' }, { from: 'nope' }];
    for (const q of queries) {
      for (const name of ['Herotel', undefined]) {
        const { items, back } = buildInvoiceTrail('customer', q, name, 'INV1');
        expect(items[items.length - 2]!.href).toBe(back.href);
      }
    }
  });
});
