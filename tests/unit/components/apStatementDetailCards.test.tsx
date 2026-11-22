// AP supplier statement detail: both tables become labelled cards below lg, and its controls are 44px on phones.
import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('next/router', () => ({ useRouter: () => ({ isReady: true, query: { id: 'recon-1' }, push: vi.fn() }) }));
vi.mock('@/lib/apiFetch', async (orig) => ({
  ...(await orig<typeof import('@/lib/apiFetch')>()),
  apiFetch: vi.fn(async () => new Response(JSON.stringify({
    success: true,
    data: {
      id: 'recon-1', supplierId: 's1', supplierName: 'Acme', statementDate: '2026-08-31', periodStart: null, periodEnd: null,
      supplierBalance: 300, isaflowBalance: 250, variance: 50, status: 'unreconciled', extractionError: null, retryable: false, pagesDone: null, pagesTotal: null,
      missingInIsaflowCount: 0, missingInStatementCount: 1, amountDiffCount: 0, openingBalance: null,
      lines: [{ id: 'l1', lineDate: '2026-08-01', reference: 'REF1', description: 'Goods', debit: 100, credit: 0, runningBalance: null,
        matchedSupplierInvoiceId: 'inv1', matchedInvoiceNumber: 'INV-1', matchConfidence: 1, mismatchReason: null, isOpeningBalance: false },
        { id: 'l2', lineDate: '2026-08-05', reference: 'REF2', description: 'Payment', debit: 0, credit: 200, runningBalance: null,
          matchedSupplierInvoiceId: null, matchedInvoiceNumber: null, matchConfidence: null, mismatchReason: 'missing_in_isaflow', isOpeningBalance: false }],
      missingInvoices: [{ invoiceId: 'inv2', invoiceNumber: 'INV-2', invoiceDate: '2026-08-02', totalAmount: 50 }],
      createdAt: '2026-09-01T00:00:00Z', reconciledAt: null,
    },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })),
}));

import Page from '../../../pages/accounting/ap/supplier-statements/[id]';

afterEach(cleanup);
const labels = (table: Element) => [...table.querySelectorAll('tbody tr:first-child td')].map(td => td.getAttribute('data-label'));
const heads = (table: Element) => [...table.querySelectorAll('thead th')].map(th => th.textContent);

describe('AP statement detail on touch', () => {
  it('turns the statement lines and the missing invoices into labelled cards', async () => {
    const { container } = render(<Page />);
    await screen.findByText('Goods');
    await screen.findByText('INV-2');
    const tables = [...container.querySelectorAll('table')];
    expect(tables).toHaveLength(2);
    for (const t of tables) {
      expect(t.className).toContain('table-cards');
      expect(t.className).not.toMatch(/(^|\s)min-w-\[/);
      expect(t.className).toMatch(/lg:min-w-\[/);
      // Labels come from the headers, so a renamed header cannot drift from its data-label.
      expect(labels(t)).toEqual(heads(t));
    }
    // The 200px clamp is for the desktop column only: on a card the description spans the full width.
    const description = container.querySelector('td[data-label="Description"]')!;
    expect(description.className.split(/\s+/)).toEqual(expect.arrayContaining(['lg:max-w-[200px]', 'lg:truncate']));
    expect(description.className.split(/\s+/)).not.toContain('max-w-[200px]');
    expect(description.className.split(/\s+/)).not.toContain('truncate');
  });

  it('gives every control 44px on phones', async () => {
    render(<Page />);
    await screen.findByText('Goods');
    for (const name of [/Back to statements/, /Rematch/, /Mark reconciled/, /Invoices not on statement/, /INV-1/, /Create invoice/]) {
      expect(screen.getByRole('button', { name }).className).toContain('max-lg:min-h-11');
    }
  });

  it('gives the toast dismiss button a name and a 44px phone target', async () => {
    render(<Page />);
    await screen.findByText('Goods');
    fireEvent.click(screen.getByRole('button', { name: /Rematch/ }));
    const dismiss = await screen.findByRole('button', { name: 'Dismiss' });
    expect(dismiss.className).toContain('max-lg:min-h-11');
    expect(dismiss.className).toContain('max-lg:min-w-11');
  });
});
