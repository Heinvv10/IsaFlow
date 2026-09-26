// MarkVatDeclaredElsewhereButton — the single-invoice affordance on the
// customer-invoice / supplier-bill detail pages.
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ apiFetchMock: vi.fn(), role: 'owner' }));
vi.mock('@/lib/apiFetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/apiFetch')>()),
  apiFetch: h.apiFetchMock,
}));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: h.role }) }));

import { MarkVatDeclaredElsewhereButton } from '@/components/accounting/sars/MarkVatDeclaredElsewhereButton';

const ok = () => new Response(JSON.stringify({ success: true, data: {} }), { status: 200 });
const refused = (message: string) => new Response(JSON.stringify({ success: false, message }), { status: 400 });

afterEach(() => { h.apiFetchMock.mockReset(); h.role = 'owner'; });

it('is hidden when the invoice has a live GL journal', () => {
  render(<MarkVatDeclaredElsewhereButton kind="customer" invoiceId="i-1" glJournalEntryId="je-1" taxAmount={100} />);
  expect(screen.queryByText(/Mark VAT declared/)).toBeNull();
});

it('is hidden when there is no VAT to declare', () => {
  render(<MarkVatDeclaredElsewhereButton kind="customer" invoiceId="i-1" glJournalEntryId={null} taxAmount={0} />);
  expect(screen.queryByText(/Mark VAT declared/)).toBeNull();
});

it('is hidden for a non-owner/admin even when eligible', () => {
  h.role = 'manager';
  render(<MarkVatDeclaredElsewhereButton kind="customer" invoiceId="i-1" glJournalEntryId={null} taxAmount={100} />);
  expect(screen.queryByText(/Mark VAT declared/)).toBeNull();
});

it('an owner marks it, which posts and shows a confirmation', async () => {
  h.apiFetchMock.mockResolvedValue(ok());
  window.prompt = vi.fn().mockReturnValue('Historical import');
  const onMarked = vi.fn();
  render(<MarkVatDeclaredElsewhereButton kind="supplier" invoiceId="bill-1" glJournalEntryId={null} taxAmount={45} onMarked={onMarked} />);
  fireEvent.click(screen.getByText(/Mark VAT declared/));
  await Promise.resolve(); await Promise.resolve();
  expect(h.apiFetchMock).toHaveBeenCalledWith('/api/accounting/vat-declared-elsewhere', expect.objectContaining({
    method: 'POST', body: JSON.stringify({ action: 'mark', kind: 'supplier', invoiceIds: ['bill-1'], reason: 'Historical import' }),
  }));
  expect(onMarked).toHaveBeenCalled();
  expect(await screen.findByText(/Marked VAT declared outside IsaFlow/)).toBeTruthy();
});

it('a refusal (400) shows the server message, does not call onMarked, and does not show the confirmation', async () => {
  h.apiFetchMock.mockResolvedValue(refused('Only an owner or admin can mark this'));
  window.prompt = vi.fn().mockReturnValue('Historical import');
  const onMarked = vi.fn();
  render(<MarkVatDeclaredElsewhereButton kind="supplier" invoiceId="bill-1" glJournalEntryId={null} taxAmount={45} onMarked={onMarked} />);
  fireEvent.click(screen.getByText(/Mark VAT declared/));

  expect(await screen.findByText(/Only an owner or admin can mark this/)).toBeTruthy();
  expect(onMarked).not.toHaveBeenCalled();
  expect(screen.queryByText(/Marked VAT declared outside IsaFlow/)).toBeNull();
  // The button is still there — the caller can retry.
  expect(screen.getByText(/Mark VAT declared/)).toBeTruthy();
});
