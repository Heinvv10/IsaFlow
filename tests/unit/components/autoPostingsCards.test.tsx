// Auto-postings audit trail: the table becomes labelled cards below lg; links, filters and pagination are 44px on phones.
import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PAGE_SIZE } from '../../../src/components/accounting/autoPostings/autoPostingsModel';

vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/hooks/useHrefVisible', () => ({ useHrefVisible: () => () => true }));
vi.mock('@/lib/apiFetch', async (orig) => ({
  ...(await orig<typeof import('@/lib/apiFetch')>()),
  apiFetch: vi.fn(async () => new Response(JSON.stringify({
    success: true,
    data: {
      total: PAGE_SIZE * 2,
      breakdown: { auto_invoice: 1 },
      entries: [{
        id: 'e1', entryNumber: 'JE-1', entryDate: '2026-05-01', source: 'auto_invoice', description: 'Invoice INV-1 posted',
        lineCount: 2, totalDebit: 100, totalCredit: 100, sourceDocumentId: 'd1',
      }],
    },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })),
}));

import Page from '../../../pages/accounting/auto-postings';

afterEach(cleanup);
const HEADS = ['Entry #', 'Date', 'Source', 'Description', 'Lines', 'Debit', 'Credit', 'Source doc'];

describe('Auto-postings on touch', () => {
  it('turns the table into labelled cards whose labels equal the headers', async () => {
    const { container } = render(<Page />);
    await screen.findByText('JE-1');
    const table = container.querySelector('table')!;
    expect(table.className).toContain('table-cards');
    expect([...table.querySelectorAll(':scope > thead th')].map(th => th.textContent)).toEqual(HEADS);
    const row = table.querySelector(':scope > tbody > tr')!;
    expect([...row.querySelectorAll(':scope > td')].map(td => td.getAttribute('data-label'))).toEqual(HEADS);
    // The description is truncated on desktop; on a card it must wrap instead of overflowing.
    const desc = row.querySelectorAll(':scope > td')[3].className.split(' ');
    expect(desc).toEqual(expect.arrayContaining(['max-lg:whitespace-normal', 'max-lg:max-w-none']));
  });

  it('makes the entry and source-document links 44px and centred against their labels', async () => {
    render(<Page />);
    await screen.findByText('JE-1');
    for (const name of ['JE-1', 'Open']) {
      const link = screen.getByRole('link', { name });
      for (const c of ['max-lg:inline-flex', 'max-lg:items-center', 'max-lg:min-h-11']) expect(link.className, name).toContain(c);
      expect(link.closest('td')!.className, name).toContain('max-lg:items-center');
    }
  });

  it('makes the source filter, Clear and the pager buttons 44px on phones', async () => {
    const { container } = render(<Page />);
    await screen.findByText('JE-1');
    expect(container.querySelector('select')!.className).toContain('max-lg:min-h-11');
    fireEvent.change(container.querySelector('select')!, { target: { value: 'auto_invoice' } });
    for (const name of ['Clear', 'Previous', 'Next']) expect((await screen.findByRole('button', { name })).className, name).toContain('max-lg:min-h-11');
  });
});
