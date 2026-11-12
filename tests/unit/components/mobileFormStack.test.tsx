// App audit 12 Nov 2026 (P2.5 item 3, High): the receipt, supplier payment and credit note forms kept a fixed
// `flex` row with a `w-72 shrink-0` summary at every width, so at 390 px the form column was crushed to ~30 px
// under the summary card. This is a CLASS GUARD only: jsdom has no layout, so it cannot prove the form is usable on
// a phone. The real check is the geometry test in tests/e2e/golden-paths/y8-purchase-forms-390.spec.ts.
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import './supplierFormHarness';
import NewCustomerPayment from '../../../pages/accounting/customer-payments/new';
import NewSupplierPayment from '../../../pages/accounting/supplier-payments/new';
import NewCreditNote from '../../../pages/accounting/credit-notes/new';

const FORMS = [
  { name: 'customer-payments/new', Page: NewCustomerPayment, summary: 'Payment Summary', details: 'Payment Details' },
  { name: 'supplier-payments/new', Page: NewSupplierPayment, summary: 'Payment Summary', details: 'Payment Details' },
  { name: 'credit-notes/new', Page: NewCreditNote, summary: 'Summary', details: 'Credit Note Details' },
];

const classes = (el: Element | null | undefined): string[] => (el?.getAttribute('class') ?? '').split(/\s+/);

describe.each(FORMS)('$name at phone width', ({ Page, summary, details }) => {
  it('stacks the summary under the form below lg, beside it from lg up', () => {
    render(<Page />);
    const sidebar = screen.getByRole('heading', { name: summary, exact: true }).closest('.shrink-0');
    expect(sidebar, 'summary column').not.toBeNull();
    expect(classes(sidebar)).toEqual(expect.arrayContaining(['w-full', 'lg:w-72']));
    expect(classes(sidebar)).not.toContain('w-72');
    expect(classes(sidebar?.parentElement)).toEqual(expect.arrayContaining(['flex-col', 'lg:flex-row']));
  });

  it('gives the details card one column of fields on a phone', () => {
    render(<Page />);
    const card = screen.getByRole('heading', { name: new RegExp(details) }).parentElement;
    const grid = card?.querySelector('.grid');
    expect(classes(grid)).toContain('grid-cols-1');
    expect(classes(grid).filter(c => /^grid-cols-[2-9]$/.test(c)), 'multi-column only from sm up').toEqual([]);
  });
});
