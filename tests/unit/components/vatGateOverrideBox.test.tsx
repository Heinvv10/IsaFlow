// VatPeriodLockForm's blocking-exceptions notice: an owner/admin sees a
// required override reason box, everyone else sees only the counts and a
// note that they cannot override it; a clean period shows neither.
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ apiFetchMock: vi.fn(), role: 'owner' }));
vi.mock('@/lib/apiFetch', () => ({ apiFetch: h.apiFetchMock }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: h.role }) }));
const apiFetchMock = h.apiFetchMock;

import { VatPeriodLockForm } from '@/components/accounting/sars/VatPeriodLockForm';

const okJson = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });

afterEach(() => { apiFetchMock.mockReset(); h.role = 'owner'; });

async function fillPeriod() {
  const { container } = render(<VatPeriodLockForm onLock={vi.fn().mockResolvedValue(null)} />);
  fireEvent.change(container.querySelector('input[name="periodStart"]')!, { target: { value: '2026-03-01' } });
  fireEvent.change(container.querySelector('input[name="periodEnd"]')!, { target: { value: '2026-04-30' } });
  return container;
}

describe('a clean period', () => {
  it('shows no override box', async () => {
    apiFetchMock.mockResolvedValue(okJson({ totalExceptions: 0 }));
    await fillPeriod();
    expect(await screen.findByText('Lock period')).toBeTruthy();
    expect(screen.queryByText(/blocking VAT exception/)).toBeNull();
  });
});

describe('blocking exceptions present', () => {
  it('an owner sees the counts and a required reason box', async () => {
    apiFetchMock.mockResolvedValue(okJson({ totalExceptions: 3, unpostedInvoiceVatCount: 3 }));
    await fillPeriod();
    expect(await screen.findByText(/3 blocking VAT exceptions/)).toBeTruthy();
    expect(screen.getByLabelText(/Override reason/)).toBeTruthy();
  });

  it('a non-owner/admin sees the counts but no reason box', async () => {
    h.role = 'manager';
    // unsupportedInputVatCount no longer drives totalExceptions on its own
    // (Hein, 2026-09-26) — uncodedGlLineCount is a still-blocking category.
    apiFetchMock.mockResolvedValue(okJson({ totalExceptions: 2, uncodedGlLineCount: 2 }));
    await fillPeriod();
    expect(await screen.findByText(/2 blocking VAT exceptions/)).toBeTruthy();
    expect(screen.queryByLabelText(/Override reason/)).toBeNull();
    expect(screen.getByText(/Only an owner or admin can override/)).toBeTruthy();
  });

  it('an owner\'s typed reason is submitted with the lock', async () => {
    apiFetchMock.mockResolvedValue(okJson({ totalExceptions: 1, unpostedInvoiceVatCount: 1 }));
    const onLock = vi.fn().mockResolvedValue(null);
    const { container } = render(<VatPeriodLockForm onLock={onLock} />);
    fireEvent.change(container.querySelector('input[name="periodStart"]')!, { target: { value: '2026-03-01' } });
    fireEvent.change(container.querySelector('input[name="periodEnd"]')!, { target: { value: '2026-04-30' } });
    const textarea = await screen.findByLabelText(/Override reason/);
    fireEvent.change(textarea, { target: { value: 'Historical import' } });
    fireEvent.click(screen.getByText('Lock period'));
    await Promise.resolve();
    expect(onLock).toHaveBeenCalledWith('2026-03-01', '2026-04-30', '', 'Historical import');
  });
});
