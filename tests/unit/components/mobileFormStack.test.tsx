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

// Second pass (16 Nov): 44 px tap targets below lg, every visible label tied to its control, icon buttons named, and
// the submit row pinned to the bottom of the screen below lg (in the lg:sticky summary card from lg). Class guards only;
// the pinned bar's geometry is in the y8 golden.
const TAP = 'max-lg:min-h-11';
// Read-only display cells: a <div>, not a labelable control.
const DISPLAY_LABELS = new Set(['Balance', 'VAT amount']);
const SUBMIT = { 'customer-payments/new': 'Create Payment', 'supplier-payments/new': 'Create Payment', 'credit-notes/new': 'Create Credit Note' };

const visibleLabels = (heading: string): HTMLLabelElement[] =>
  [...(screen.getByRole('heading', { name: new RegExp(heading) }).closest('.rounded-2xl')?.querySelectorAll('label') ?? [])];

describe.each(FORMS)('$name tap targets, labels and the pinned submit row', ({ name, Page, summary, cards }) => {
  it.each(cards)('ties every %s label to a 44 px control', (heading) => {
    render(<Page />);
    if (name === 'credit-notes/new') fireEvent.change(screen.getByLabelText('Type *'), { target: { value: 'supplier' } });
    const labels = visibleLabels(heading).filter(l => !DISPLAY_LABELS.has(l.textContent ?? ''));
    expect(labels.length, 'the card has labels').toBeGreaterThan(1);
    for (const label of labels) {
      expect(label.control, `${label.textContent} has a control`).not.toBeNull();
      expect(classes(label.control), `${label.textContent} is 44 px below lg`).toContain(TAP);
    }
  });

  it('pins the submit row to the bottom below lg and keeps the summary sticky from lg only', () => {
    render(<Page />);
    const submit = screen.getByRole('button', { name: SUBMIT[name as keyof typeof SUBMIT] });
    expect(classes(submit)).toEqual(expect.arrayContaining(['w-full', 'mt-6', 'max-lg:mt-0', 'max-lg:flex-1', TAP]));
    expect(classes(submit.parentElement)).toEqual(expect.arrayContaining([
      'max-lg:fixed', 'max-lg:inset-x-0', 'max-lg:bottom-0', 'max-lg:pb-[calc(0.75rem+env(safe-area-inset-bottom))]',
      'max-lg:bg-[var(--ff-bg-secondary)]', 'max-lg:border-[var(--ff-border-light)]',
    ]));
    expect(classes(submit.closest('form')), 'room under the form for the bar').toContain('max-lg:pb-32');
    const sticky = screen.getByRole('heading', { name: summary }).closest('.shrink-0')?.firstElementChild;
    expect(classes(sticky)).toEqual(expect.arrayContaining(['lg:sticky', 'lg:top-6']));
    expect(classes(sticky), 'no sticky top on a phone').not.toContain('sticky');
  });
});

describe.each([
  { name: 'customer-payments/new', Page: NewCustomerPayment, add: 'Add Line' },
  { name: 'supplier-payments/new', Page: NewSupplierPayment, add: 'Add Allocation' },
])('$name allocation controls', ({ Page, add }) => {
  it('makes Add and each named bin a 44 px target below lg', () => {
    render(<Page />);
    const addButton = screen.getByRole('button', { name: new RegExp(add) });
    expect(classes(addButton)).toContain(TAP);
    fireEvent.click(addButton);
    for (const n of [1, 2]) {
      expect(classes(screen.getByRole('button', { name: `Remove allocation ${n}` })), `bin ${n}`)
        .toEqual(expect.arrayContaining([TAP, 'max-lg:min-w-11']));
    }
  });
});

describe('labels per allocation row', () => {
  it('names the receipt amount field', () => {
    render(<NewCustomerPayment />);
    expect(classes(screen.getByRole('spinbutton', { name: 'Amount' }))).toContain(TAP);
  });

  it('ties each supplier payment row label to that row', () => {
    render(<NewSupplierPayment />);
    fireEvent.click(screen.getByRole('button', { name: /Add Allocation/ }));
    for (const text of ['Invoice', 'Pay amount']) {
      const controls = screen.getAllByText(text, { selector: 'label' }).map(l => (l as HTMLLabelElement).control);
      expect(controls[0], `row 1 ${text}`).not.toBeNull();
      expect(controls[1], `row 2 ${text}`).not.toBeNull();
      expect(controls[0], `${text} rows have their own ids`).not.toBe(controls[1]);
    }
  });
});
