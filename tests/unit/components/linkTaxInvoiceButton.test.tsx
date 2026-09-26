// LinkTaxInvoiceButton — link a captured document to a posted journal
// (VAT-gaps batch item 1, journal detail page + exceptions panel).
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ apiFetchMock: vi.fn() }));
vi.mock('@/lib/apiFetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/apiFetch')>()),
  apiFetch: h.apiFetchMock,
}));

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
  const onChanged = vi.fn();
  render(<LinkTaxInvoiceButton journalEntryId="je-1" onChanged={onChanged} />);
  fireEvent.click(screen.getByText(/Link tax invoice/));
  await screen.findByText(/invoice\.pdf/);
  fireEvent.click(screen.getByRole('button', { name: 'Link' }));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Matches the bill' } });
  fireEvent.click(screen.getByRole('button', { name: 'Link' }));
  await waitFor(() => expect(h.apiFetchMock).toHaveBeenCalledWith('/api/accounting/journal-document-links', expect.objectContaining({
    method: 'POST',
    body: JSON.stringify({ action: 'link', journalEntryId: 'je-1', capturedDocumentId: 'doc-1', reason: 'Matches the bill' }),
  })));
  expect(onChanged).toHaveBeenCalled();
});

it('the confirm button is disabled until a reason is typed', async () => {
  h.apiFetchMock.mockResolvedValueOnce(jsonRes({ links: [], candidates: [{ id: 'doc-1', fileName: 'invoice.pdf', documentType: null }] }));
  render(<LinkTaxInvoiceButton journalEntryId="je-1" />);
  fireEvent.click(screen.getByText(/Link tax invoice/));
  await screen.findByText(/invoice\.pdf/);
  fireEvent.click(screen.getByRole('button', { name: 'Link' }));

  const confirmButton = screen.getByRole('button', { name: 'Link' }) as HTMLButtonElement;
  expect(confirmButton.disabled).toBe(true);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '  ' } });
  expect(confirmButton.disabled).toBe(true);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'A real reason' } });
  expect(confirmButton.disabled).toBe(false);
});

it('shows an active link with an unlink action instead of the picker', async () => {
  h.apiFetchMock.mockResolvedValue(jsonRes({ links: [{ id: 'link-1', capturedDocumentId: 'doc-1' }], candidates: [] }));
  render(<LinkTaxInvoiceButton journalEntryId="je-1" />);
  fireEvent.click(screen.getByText(/Link tax invoice/));
  expect(await screen.findByText(/Unlink/)).toBeTruthy();
});

it('a refused link (400) shows the server message, stays open, and never reports success', async () => {
  const errRes = new Response(JSON.stringify({ success: false, message: 'Captured document already linked' }), { status: 400 });
  h.apiFetchMock
    .mockResolvedValueOnce(jsonRes({ links: [], candidates: [{ id: 'doc-1', fileName: 'invoice.pdf', documentType: null }] }))
    .mockResolvedValueOnce(errRes);
  const onChanged = vi.fn();
  render(<LinkTaxInvoiceButton journalEntryId="je-1" onChanged={onChanged} />);
  fireEvent.click(screen.getByText(/Link tax invoice/));
  await screen.findByText(/invoice\.pdf/);
  fireEvent.click(screen.getByRole('button', { name: 'Link' }));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Matches the bill' } });
  fireEvent.click(screen.getByRole('button', { name: 'Link' }));

  expect(await screen.findByText(/Captured document already linked/)).toBeTruthy();
  expect(onChanged).not.toHaveBeenCalled();
  // Still open, the reason form still visible — not silently closed as if it worked.
  expect(screen.getByRole('textbox')).toBeTruthy();
});

it('an unlink that fails on the server shows the error and does not clear the active link', async () => {
  const errRes = new Response(JSON.stringify({ success: false, message: 'No active link found' }), { status: 400 });
  h.apiFetchMock
    .mockResolvedValueOnce(jsonRes({ links: [{ id: 'link-1', capturedDocumentId: 'doc-1' }], candidates: [] }))
    .mockResolvedValueOnce(errRes);
  const onChanged = vi.fn();
  render(<LinkTaxInvoiceButton journalEntryId="je-1" onChanged={onChanged} />);
  fireEvent.click(screen.getByText(/Link tax invoice/));
  await screen.findByText(/Unlink/);
  fireEvent.click(screen.getByText(/Unlink/));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Wrong entry' } });
  fireEvent.click(screen.getByRole('button', { name: 'Unlink' }));

  expect(await screen.findByText(/No active link found/)).toBeTruthy();
  expect(onChanged).not.toHaveBeenCalled();
  expect(screen.getByRole('textbox')).toBeTruthy();
});
