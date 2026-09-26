// VatUnpostedInvoicesSection's bulk "mark declared elsewhere" action and
// VatDeclaredElsewhereSection's per-row unmark — both owner/admin only.
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ apiFetchMock: vi.fn(), role: 'owner' }));
vi.mock('@/lib/apiFetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/apiFetch')>()),
  apiFetch: h.apiFetchMock,
}));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: h.role }) }));

import VatUnpostedInvoicesSection from '@/components/accounting/sars/VatUnpostedInvoicesSection';
import VatDeclaredElsewhereSection from '@/components/accounting/sars/VatDeclaredElsewhereSection';

const ok = () => new Response(JSON.stringify({ success: true, data: {} }), { status: 200 });
const refused = (message: string) => new Response(JSON.stringify({ success: false, message }), { status: 400 });
const Section = ({ title, count, children }: { title: string; count: number; listed: number; children: React.ReactNode }) => (
  <div><h3>{title} ({count})</h3>{children}</div>
);

afterEach(() => { h.apiFetchMock.mockReset(); h.role = 'owner'; vi.restoreAllMocks(); });

const unpostedReport = {
  unpostedInvoiceVat: [{ invoiceId: 'ci-1', invoiceKind: 'customer' as const, invoiceNumber: 'INV-1', counterpartyName: 'Acme', invoiceDate: '2026-07-01', vat: 150, reason: 'no_journal' as const }],
  unpostedInvoiceVatCount: 1,
  controlRecon: { unpostedCustomerVat: 150, unpostedCustomerCount: 1, unpostedSupplierVat: 0, unpostedSupplierCount: 0 } as never,
};

describe('VatUnpostedInvoicesSection bulk mark', () => {
  it('an owner sees the checkbox and mark button; selecting + confirming posts a mark for that invoice', async () => {
    h.apiFetchMock.mockResolvedValue(ok());
    window.prompt = vi.fn().mockReturnValue('Historical import');
    const onChanged = vi.fn();
    render(<VatUnpostedInvoicesSection report={unpostedReport} Section={Section} onChanged={onChanged} />);

    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByText(/Mark 1 declared elsewhere/));
    await Promise.resolve(); await Promise.resolve();

    expect(h.apiFetchMock).toHaveBeenCalledWith('/api/accounting/vat-declared-elsewhere', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ action: 'mark', kind: 'customer', invoiceIds: ['ci-1'], reason: 'Historical import' }),
    }));
    expect(onChanged).toHaveBeenCalled();
  });

  it('a non-owner/admin sees no checkbox or mark button', () => {
    h.role = 'manager';
    render(<VatUnpostedInvoicesSection report={unpostedReport} Section={Section} />);
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByText(/declared elsewhere/)).toBeNull();
  });

  it('does nothing when the prompt is cancelled', async () => {
    window.prompt = vi.fn().mockReturnValue(null);
    render(<VatUnpostedInvoicesSection report={unpostedReport} Section={Section} />);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByText(/Mark 1 declared elsewhere/));
    await Promise.resolve();
    expect(h.apiFetchMock).not.toHaveBeenCalled();
  });

  it('a refused mark (400) shows the server message, keeps the selection, and never calls onChanged', async () => {
    h.apiFetchMock.mockResolvedValue(refused('Only an owner or admin can mark this'));
    window.prompt = vi.fn().mockReturnValue('Historical import');
    const onChanged = vi.fn();
    render(<VatUnpostedInvoicesSection report={unpostedReport} Section={Section} onChanged={onChanged} />);

    const checkbox = screen.getByRole('checkbox') as HTMLInputElement;
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByText(/Mark 1 declared elsewhere/));

    expect(await screen.findByText(/Only an owner or admin can mark this/)).toBeTruthy();
    expect(onChanged).not.toHaveBeenCalled();
    // Selection is NOT cleared on failure — the checkbox stays checked so the
    // user can see what still needs marking and retry.
    expect(checkbox.checked).toBe(true);
  });
});

describe('VatDeclaredElsewhereSection', () => {
  const declaredReport = {
    declaredElsewhereVat: [{
      invoiceId: 'ci-2', invoiceKind: 'customer' as const, invoiceNumber: 'INV-2', counterpartyName: 'Beta',
      invoiceDate: '2026-07-02', vat: 90, markedAt: '2026-07-10T00:00:00.000Z', markedBy: 'u-1', markedReason: 'Historical',
    }],
    declaredElsewhereVatCount: 1,
  };

  it('renders nothing when there is nothing marked', () => {
    const { container } = render(<VatDeclaredElsewhereSection report={{ declaredElsewhereVat: [], declaredElsewhereVatCount: 0 }} onChanged={vi.fn()} />);
    expect(container.innerHTML).toBe('');
  });

  it('an owner can unmark, which posts and calls onChanged', async () => {
    h.apiFetchMock.mockResolvedValue(ok());
    window.prompt = vi.fn().mockReturnValue('Reopen');
    const onChanged = vi.fn();
    render(<VatDeclaredElsewhereSection report={declaredReport} onChanged={onChanged} />);
    fireEvent.click(screen.getByText('Unmark'));
    await Promise.resolve(); await Promise.resolve();
    expect(h.apiFetchMock).toHaveBeenCalledWith('/api/accounting/vat-declared-elsewhere', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ action: 'unmark', kind: 'customer', invoiceIds: ['ci-2'], reason: 'Reopen' }),
    }));
    expect(onChanged).toHaveBeenCalled();
  });

  it('a non-owner/admin sees the row but no unmark action', () => {
    h.role = 'manager';
    render(<VatDeclaredElsewhereSection report={declaredReport} onChanged={vi.fn()} />);
    expect(screen.getByText('INV-2')).toBeTruthy();
    expect(screen.queryByText('Unmark')).toBeNull();
  });

  it('a refused unmark (400) shows the server message and never calls onChanged', async () => {
    h.apiFetchMock.mockResolvedValue(refused('No active mark found'));
    window.prompt = vi.fn().mockReturnValue('Reopen');
    const onChanged = vi.fn();
    render(<VatDeclaredElsewhereSection report={declaredReport} onChanged={onChanged} />);
    fireEvent.click(screen.getByText('Unmark'));

    expect(await screen.findByText(/No active mark found/)).toBeTruthy();
    expect(onChanged).not.toHaveBeenCalled();
    // The row is still there, unmark still offered — nothing was silently cleared.
    expect(screen.getByText('INV-2')).toBeTruthy();
    expect(screen.getByText('Unmark')).toBeTruthy();
  });
});
