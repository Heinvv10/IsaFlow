// Captured documents list and the group entity summary: labelled cards below lg (first column = card heading); header controls wrap; the status cell is one value; totals row labelled.
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { DocumentList } from '../../../src/components/accounting/document-capture/DocumentList';
import { GroupEntityTable } from '../../../src/components/accounting/group/GroupEntityTable';

afterEach(cleanup);
const cls = (el: Element) => el.className.split(' ');
const doc = (n: string, readState: string) => ({ id: n, fileName: `invoice-${n}.pdf`, documentType: 'invoice', vendorName: `Vendor ${n}`, documentDate: '2026-11-01', referenceNumber: `REF-${n}`, totalAmount: 1150, status: 'pending', readState, createdAt: '2026-11-02T08:00:00Z' });

describe('DocumentList on touch', () => {
  const props = { total: 2, isLoading: false, error: '', statusFilter: '', onStatusFilterChange: () => undefined };
  const HEADS = ['File', 'Type', 'Vendor', 'Date', 'Reference', 'Total', 'Status', 'Uploaded', ''];

  it('is labelled cards matching the headers, file = heading, view link unlabelled', () => {
    const { container } = render(<DocumentList {...props} documents={[doc('1', 'done'), doc('2', 'failed')] as never} />);
    const table = container.querySelector('table')!;
    expect(cls(table)).toContain('table-cards');
    expect([...table.querySelectorAll('thead th')].map((th) => th.textContent)).toEqual(HEADS);
    const rows = [...table.querySelectorAll('tbody tr')];
    expect(rows).toHaveLength(2);
    for (const r of rows) expect([...r.querySelectorAll('td')].map((td) => td.getAttribute('data-label'))).toEqual([null, ...HEADS.slice(1, 8), null]);
  });

  it('the Status cell is one value even with the read-failed badge, the View link and the status filter are 44px, the header wraps', () => {
    const { container } = render(<DocumentList {...props} documents={[doc('2', 'failed')] as never} />);
    const status = container.querySelector('td[data-label="Status"]')!;
    expect(status.children).toHaveLength(1);
    expect(status.textContent).toContain('Read failed');
    expect(cls(screen.getByRole('link', { name: /View/ }))).toContain('max-lg:min-h-11');
    const select = screen.getByRole('combobox');
    expect(cls(select)).toContain('max-lg:min-h-11');
    expect(cls(select.parentElement!)).toEqual(expect.arrayContaining(['max-lg:flex-wrap', 'max-lg:gap-3']));
  });
});

describe('GroupEntityTable on touch', () => {
  const entities = [1, 2].map((n) => ({ companyId: `c${n}`, companyName: `Company ${n}`, revenue: 1000 * n, expenses: 400 * n, netProfit: 600 * n, cashPosition: 250 * n }));
  const totals = { revenue: 3000, expenses: 1200, netProfit: 1800, cashPosition: 750 };
  const HEADS = ['Company Name', 'Revenue', 'Expenses', 'Net Profit', 'Cash Position'];

  it('is labelled cards; the total row carries the same labels with the name cell as its heading', () => {
    const { container } = render(<GroupEntityTable entities={entities} totals={totals} />);
    const table = container.querySelector('table')!;
    expect(cls(table)).toContain('table-cards');
    expect([...table.querySelectorAll('thead th')].map((th) => th.textContent)).toEqual(HEADS);
    const rows = [...table.querySelectorAll('tbody tr')];
    expect(rows).toHaveLength(3); // two entities + the total row
    for (const r of rows) expect([...r.querySelectorAll('td')].map((td) => td.getAttribute('data-label'))).toEqual([null, ...HEADS.slice(1)]);
    expect(rows[2]!.textContent).toContain('Total');
  });

  it('the empty state is a centred full-width block', () => {
    render(<GroupEntityTable entities={[]} totals={totals} />);
    const td = screen.getByText('No entities in this group yet.').closest('td')!;
    expect(cls(td)).toEqual(expect.arrayContaining(['max-lg:!py-8', 'max-lg:!text-center']));
  });
});
