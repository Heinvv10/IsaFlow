/**
 * The AR migration wizard page, driven over a stubbed network.
 *
 * - First upload previewed every row as NONE: handleFile loaded the customers
 *   into state and then matched against the STALE empty array from the same
 *   render. It now matches against the list it just loaded (as AP does).
 * - An operator's override is sent as `customerId` (the route used to strip it);
 *   an automatic match is not sent at all — the server makes the same match.
 * - SA dates and amounts in the file are sent as ISO dates and numbers.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('@/components/layout/AppLayout', () => ({
  AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

// Papa reads a File through FileReader, which never settles under happy-dom.
vi.mock('papaparse', () => ({
  default: {
    parse: (_file: unknown, opts: { complete: (r: { data: Record<string, string>[]; meta: { fields: string[] } }) => void }) => {
      opts.complete({ data: PARSED, meta: { fields: Object.keys(PARSED[0]!) } });
    },
  },
}));

import ArInvoicesPage from '../../../pages/accounting/migration/ar-invoices';

const SESSION_ID = '11111111-2222-3333-4444-555555555555';
const ACME_ID = '66666666-7777-8888-9999-000000000000';
const BOLT_ID = '66666666-7777-8888-9999-000000000001';

let PARSED: Record<string, string>[] = [];
let posted: { sessionId?: string; invoices?: Array<Record<string, unknown>> } | null = null;

const envelope = (data: unknown) =>
  new Response(JSON.stringify({ success: true, data }), { status: 200, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  posted = null;
  PARSED = [
    { invoice_number: 'INV-1', customer_name: 'Acme Trading', invoice_date: '03/04/2026', due_date: '03 May 2026',
      subtotal: '1 000,00', tax_amount: '150,00', total_amount: 'R1,150.00', amount_paid: '' },
    { invoice_number: 'INV-2', customer_name: 'Unknown Ltd', invoice_date: '2026-04-05', due_date: '2026-05-05',
      subtotal: '100', tax_amount: '15', total_amount: '115', amount_paid: '0' },
  ];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith('/api/accounting/customers')) {
      return envelope([{ id: ACME_ID, name: 'Acme Trading' }, { id: BOLT_ID, name: 'Bolt Holdings' }]);
    }
    if (url.startsWith('/api/accounting/migration/session')) {
      return envelope({ session: { id: SESSION_ID, sourceSystem: 'sage_cloud', status: 'in_progress' } });
    }
    if (url.startsWith('/api/accounting/migration/ar-invoices')) {
      posted = JSON.parse(String(init?.body));
      return envelope({ imported: 2, skipped: 0, errors: [], warnings: [] });
    }
    throw new Error(`unexpected fetch ${url}`);
  }));
});

async function upload(container: HTMLElement) {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File(['x'], 'ar.csv', { type: 'text/csv' })] } });
  return waitFor(() => {
    const b = Array.from(container.querySelectorAll('button')).find(el => /Import 2 Invoices/.test(el.textContent ?? ''));
    if (!b) throw new Error('import button not rendered');
    return b;
  }, { timeout: 5000 });
}

describe('AR migration wizard page', () => {
  it('matches the first upload against the customers it just loaded', async () => {
    const { container } = render(<ArInvoicesPage />);
    await upload(container);
    expect(screen.getByText('HIGH')).toBeTruthy();
    expect(screen.getByText('NONE')).toBeTruthy();
  }, 20000);

  it('sends the override as customerId, never the automatic match, with ISO dates and SA amounts read', async () => {
    const { container } = render(<ArInvoicesPage />);
    const button = await upload(container);
    // Only the unmatched row offers an override; point it at Bolt.
    const select = container.querySelector('tbody select') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: BOLT_ID } });
    fireEvent.click(button);

    await waitFor(() => expect(posted).not.toBeNull(), { timeout: 5000 });
    const [first, second] = posted!.invoices!;
    expect(first!.customerId).toBeUndefined();
    expect(first).toMatchObject({
      customerName: 'Acme Trading', invoiceDate: '2026-04-03', dueDate: '2026-05-03',
      subtotal: 1000, taxAmount: 150, totalAmount: 1150, amountPaid: 0,
    });
    expect(second!.customerId).toBe(BOLT_ID);
  }, 20000);

  it('lists a garbage amount by row and does not import', async () => {
    PARSED = [{ ...PARSED[0]!, total_amount: '11x50' }, PARSED[1]!];
    const { container } = render(<ArInvoicesPage />);
    const button = await upload(container);
    expect(await screen.findByText(/total_amount "11x50" is not a number/)).toBeTruthy();
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(posted).toBeNull();
  }, 20000);
});
