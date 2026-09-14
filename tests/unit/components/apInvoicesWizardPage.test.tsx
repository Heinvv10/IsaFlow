/**
 * The AP migration wizard page, rendered and driven end to end over a stubbed
 * network.
 *
 * The AP page read the session as `json.data?.id`, while
 * `pages/api/accounting/migration/session.ts` answers
 * `apiResponse.success(res, { session })` — an envelope of
 * `{ success, data: { session }, meta }`. So `data.id` was ALWAYS undefined and
 * every click of Import threw "No active migration session" before it POSTed.
 * The import banner the page renders was therefore unreachable in the browser,
 * however well the banner component itself tested.
 *
 * The seam is response envelope -> page state -> component, which a
 * hand-propped render of the banner cannot cross. This test crosses it: the
 * fetch stub returns the REAL envelope both routes produce.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('@/components/layout/AppLayout', () => ({
  AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

// Papa.parse reads the File through FileReader, which never settles under
// happy-dom. The CSV parser is not the seam under test — the page's state flow
// from response envelope to banner is — so hand it the parsed rows directly.
vi.mock('papaparse', () => ({
  default: {
    parse: (_file: unknown, opts: { complete: (r: { data: Record<string, string>[]; meta: { fields: string[] } }) => void }) => {
      opts.complete({ data: PARSED, meta: { fields: Object.keys(PARSED[0]!) } });
    },
  },
}));

import ApInvoicesPage from '../../../pages/accounting/migration/ap-invoices';

const ROW: Record<string, string> = {
  invoice_number: 'INV-1',
  supplier_name: 'ACME Trading',
  invoice_date: '2026-06-30',
  due_date: '2026-07-30',
  subtotal: '1000',
  tax_amount: '150',
  total_amount: '1150.01',
  amount_paid: '0',
};

/** The rows the stubbed parser hands the page; a test may narrow the columns. */
let PARSED: Record<string, string>[] = [];

const SESSION_ID = '11111111-2222-3333-4444-555555555555';
const SUPPLIER_ID = '66666666-7777-8888-9999-000000000000';

/** The envelope apiResponse.success actually produces. */
const envelope = (data: unknown) =>
  new Response(
    JSON.stringify({ success: true, data, meta: { timestamp: new Date().toISOString() } }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );

let posted: { sessionId?: string; invoices?: unknown[] } | null = null;

beforeEach(() => {
  posted = null;
  PARSED = [ROW];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith('/api/accounting/suppliers')) {
      return envelope([{ id: SUPPLIER_ID, name: 'ACME Trading' }]);
    }
    if (url.startsWith('/api/accounting/migration/session')) {
      return envelope({ session: { id: SESSION_ID, sourceSystem: 'sage', status: 'in_progress' } });
    }
    if (url.startsWith('/api/accounting/migration/ap-invoices')) {
      posted = JSON.parse(String(init?.body));
      return envelope({
        imported: 1,
        skipped: 0,
        errors: [],
        warnings: [{ step: 'ap_invoices', row: 0, message: 'Imported with a rounding difference: INV-1', severity: 'warning' }],
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  }));
});



describe('AP migration wizard page', () => {
  it('reads the session envelope, POSTs the import, and renders the result banner', async () => {
    const { container } = render(<ApInvoicesPage />);

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    const file = new File(['invoice_number\nINV-1'], 'ap.csv', { type: 'text/csv' });
    fireEvent.change(input, { target: { files: [file] } });

    // The button's label is split around an icon, so match on the element.
    const button = await waitFor(() => {
      const b = Array.from(container.querySelectorAll('button'))
        .find(el => /Import 1 Invoices/.test(el.textContent ?? ''));
      if (!b) throw new Error('import button not rendered');
      return b;
    }, { timeout: 5000 });
    fireEvent.click(button);

    // It reached the POST — which it cannot do while the session read is wrong.
    await waitFor(() => expect(posted).not.toBeNull(), { timeout: 5000 });
    expect(posted!.sessionId).toBe(SESSION_ID);
    expect(posted!.invoices).toHaveLength(1);

    // And the banner the branch added is actually reachable.
    expect(await screen.findByText(/Imported 1 invoices\. Skipped: 0\./)).toBeTruthy();
    expect(await screen.findByText(/rounding difference: INV-1/)).toBeTruthy();
    expect(screen.queryByText(/No active migration session/)).toBeNull();
  }, 20000);

  it('sends NO invoiceNumber field when the operator never mapped that column', async () => {
    // `?? ''` here made an unmapped column indistinguishable from a file of
    // legitimately unnumbered bills: every row went in blank, de-duplicated
    // against its neighbours on (supplier, date, total, reference), and part of
    // the file imported while the rest was reported as already imported. The
    // route refuses the whole file on an absent field — it can only do that if
    // the page leaves it absent.
    const { invoice_number: _dropped, ...noNumberColumn } = ROW;
    PARSED = [noNumberColumn];

    const { container } = render(<ApInvoicesPage />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['x'], 'ap.csv', { type: 'text/csv' })] } });

    const button = await waitFor(() => {
      const b = Array.from(container.querySelectorAll('button'))
        .find(el => /Import 1 Invoices/.test(el.textContent ?? ''));
      if (!b) throw new Error('import button not rendered');
      return b;
    }, { timeout: 5000 });
    fireEvent.click(button);

    await waitFor(() => expect(posted).not.toBeNull(), { timeout: 5000 });
    const row = posted!.invoices![0] as Record<string, unknown>;
    expect('invoiceNumber' in row).toBe(false);
    // A mapped-but-empty cell is the other case, and still sends the field.
    expect(row.supplierName).toBe('ACME Trading');
  }, 20000);
});
