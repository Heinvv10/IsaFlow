// App audit 12 Nov 2026 (P2.5 item 3, High): the receipt, supplier payment and credit note forms kept a fixed
// `flex` row with a `w-72 shrink-0` summary at every width, so at 390 px the form column was crushed to ~30 px
// under the summary card. This is a CLASS GUARD only: jsdom has no layout, so it cannot prove the form is usable on
// a phone. The real check is the geometry test in tests/e2e/golden-paths/y8-purchase-forms-390.spec.ts.
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import './supplierFormHarness';
import NewCustomerPayment from '../../../pages/accounting/customer-payments/new';
import NewSupplierPayment from '../../../pages/accounting/supplier-payments/new';
import NewCreditNote from '../../../pages/accounting/credit-notes/new';

const FORMS = [
  { name: 'customer-payments/new', Page: NewCustomerPayment, summary: 'Payment Summary', cards: ['Payment Details'] },
  { name: 'supplier-payments/new', Page: NewSupplierPayment, summary: 'Payment Summary', cards: ['Payment Details'] },
  { name: 'credit-notes/new', Page: NewCreditNote, summary: 'Summary', cards: ['Credit Note Details', 'Amounts'] },
];

const classes = (el: Element | null | undefined): string[] => (el?.getAttribute('class') ?? '').split(/\s+/);

describe.each(FORMS)('$name at phone width', ({ Page, summary, cards }) => {
  it('stacks the summary under the form below lg, beside it from lg up', () => {
    render(<Page />);
    const sidebar = screen.getByRole('heading', { name: summary }).closest('.shrink-0');
    expect(sidebar, 'summary column').not.toBeNull();
    expect(classes(sidebar)).toEqual(expect.arrayContaining(['w-full', 'lg:w-72']));
    expect(classes(sidebar)).not.toContain('w-72');
    expect(classes(sidebar?.parentElement)).toEqual(expect.arrayContaining(['flex-col', 'lg:flex-row']));
  });

  it.each(cards)('gives the %s card one column of fields on a phone', (heading) => {
    render(<Page />);
    const grids = [...(screen.getByRole('heading', { name: new RegExp(heading) }).parentElement?.querySelectorAll('.grid') ?? [])];
    expect(grids.length, 'the card has a field grid').toBeGreaterThan(0);
    for (const grid of grids) {
      expect(classes(grid)).toContain('grid-cols-1');
      expect(classes(grid).filter(c => /^grid-cols-[2-9]$/.test(c)), 'multi-column only from sm up').toEqual([]);
      const childSpans = [...grid.children].flatMap(c => classes(c)).filter(c => /^col-span-[2-9]$/.test(c));
      expect(childSpans, 'no fixed span on a phone').toEqual([]);
    }
  });
});

// Supplier payment allocations: labels on every row on a phone (a stacked row is never unlabelled), on row 1 only
// from sm up, where they read as column headers. Rows 2+ only exist after "Add Allocation".
describe('supplier-payments/new allocation rows', () => {
  it('labels row 2 on a phone and hides those labels from sm up; row 1 labels always show', () => {
    render(<NewSupplierPayment />);
    fireEvent.click(screen.getByRole('button', { name: /Add Allocation/ }));
    for (const text of ['Invoice', 'Balance', 'Pay amount']) {
      const labels = screen.getAllByText(text, { selector: 'label' });
      expect(labels, text).toHaveLength(2);
      expect(classes(labels[0]), `row 1 ${text}`).not.toContain('sm:hidden');
      expect(classes(labels[1]), `row 2 ${text}`).toContain('sm:hidden');
      expect(classes(labels[1]), `row 2 ${text} shows on a phone`).not.toContain('hidden');
    }
  });

  it('spans the cells 12 / 6 / 6 / 12 on a phone and 6 / 2 / 3 / 1 from sm', () => {
    render(<NewSupplierPayment />);
    fireEvent.click(screen.getByRole('button', { name: /Add Allocation/ }));
    const row = screen.getAllByText('Balance', { selector: 'label' })[1].closest('.grid');
    const spans = [...(row?.children ?? [])].map(c => classes(c).filter(k => /^(sm:)?col-span-\d+$/.test(k)).join(' '));
    expect(spans).toEqual(['col-span-12 sm:col-span-6', 'col-span-6 sm:col-span-2', 'col-span-6 sm:col-span-3', 'col-span-12 sm:col-span-1']);
  });
});
