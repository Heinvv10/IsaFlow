// LinkTaxInvoiceButton — link a captured document to a posted journal
// (VAT-gaps batch item 1, journal detail page + exceptions panel).
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ apiFetchMock: vi.fn() }));
vi.mock('@/lib/apiFetch', () => ({ apiFetch: h.apiFetchMock }));

import { LinkTaxInvoiceButton } from '@/components/accounting/gl/LinkTaxInvoiceButton';

const jsonRes = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });

afterEach(() => { h.apiFetchMock.mockReset(); });

it('renders a collapsed "Link tax invoice" affordance', () => {
  render(<LinkTaxInvoiceButton journalEntryId="je-1" />);
  expect(screen.getByText(/Link tax invoice/)).toBeTruthy();
  expect(h.apiFetchMock).not.toHaveBeenCalled();
});

it('opening it loads candidates and active links, scoped to the journal', async () => {
  h.apiFetchMock.mockResolvedValue(jsonRes({
    links: [], candidates: [{ id: 'doc-1', fileName: 'invoice.pdf', documentType: 'supplier_invoice' }],
  }));
  render(<LinkTaxInvoiceButton journalEntryId="je-1" />);
  fireEvent.click(screen.getByText(/Link tax invoice/));
  await waitFor(() => expect(h.apiFetchMock).toHaveBeenCalledWith('/api/accounting/journal-document-links?journal_entry_id=je-1'));
  expect(await screen.findByText(/invoice\.pdf/)).toBeTruthy();
});

it('linking posts the selected document and reason', async () => {
  h.apiFetchMock
    .mockResolvedValueOnce(jsonRes({ links: [], candidates: [{ id: 'doc-1', fileName: 'invoice.pdf', documentType: null }] }))
    .mockResolvedValueOnce(jsonRes({ link: { id: 'link-1' } }));
  window.prompt = vi.fn().mockReturnValue('Matches the bill');
  const onChanged = vi.fn();
  render(<LinkTaxInvoiceButton journalEntryId="je-1" onChanged={onChanged} />);
  fireEvent.click(screen.getByText(/Link tax invoice/));
  await screen.findByText(/invoice\.pdf/);
  fireEvent.click(screen.getByText('Link'));
  await waitFor(() => expect(h.apiFetchMock).toHaveBeenCalledWith('/api/accounting/journal-document-links', expect.objectContaining({
    method: 'POST',
    body: JSON.stringify({ action: 'link', journalEntryId: 'je-1', capturedDocumentId: 'doc-1', reason: 'Matches the bill' }),
  })));
  expect(onChanged).toHaveBeenCalled();
});

it('shows an active link with an unlink action instead of the picker', async () => {
  h.apiFetchMock.mockResolvedValue(jsonRes({ links: [{ id: 'link-1', capturedDocumentId: 'doc-1' }], candidates: [] }));
  render(<LinkTaxInvoiceButton journalEntryId="je-1" />);
  fireEvent.click(screen.getByText(/Link tax invoice/));
  expect(await screen.findByText(/Unlink/)).toBeTruthy();
});
