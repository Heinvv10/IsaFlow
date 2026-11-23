/**
 * Intercompany P4-D (plan (i).9): cancelling a receipt that clears an intercompany payment message (stamped IC:<message id>) warns first that
 * the clearing is reversed and the message stays accepted ("Clearing voided"); any other receipt's cancel asks for the reason as before.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: { paymentId: 'p-1' }, push: vi.fn(), replace: vi.fn(), pathname: '/', isReady: true }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/modules/accounting/documents', () => ({ AccountingDocumentPanel: () => null }));
vi.mock('@/utils/toast', () => ({ notify: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
useApiJsonOverMock();

import { apiFetch } from '@/lib/apiFetch';
import PaymentDetailPage from '../../../pages/accounting/customer-payments/[paymentId]';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.mocked(apiFetch).mockReset(); });

const PAY = { id: 'p-1', paymentNumber: 'CP-1', clientId: 'c-1', clientName: 'IC Client', paymentDate: '2026-09-01', totalAmount: 400, paymentMethod: 'contra', status: 'confirmed', allocations: [] };

async function cancelPrompt(bankReference: string | undefined): Promise<string> {
  vi.mocked(apiFetch).mockImplementation(async () => new Response(JSON.stringify({ success: true, data: { ...PAY, bankReference } }), { status: 200 }));
  const prompt = vi.fn(() => null);
  vi.stubGlobal('prompt', prompt);
  render(<PaymentDetailPage />);
  fireEvent.click(await screen.findByRole('button', { name: /cancel payment/i }));
  expect(prompt).toHaveBeenCalledTimes(1);
  return String((prompt.mock.calls[0] as unknown[])[0]);
}

describe('cancelling an intercompany clearing receipt', () => {
  it('warns that the clearing is reversed and the message stays accepted, then asks for the reason', async () => {
    const text = await cancelPrompt('IC:7d1f0000-0000-4000-8000-000000000001');
    expect(text).toMatch(/clears an intercompany payment from your group/);
    expect(text).toMatch(/Clearing voided/);
    expect(text).toMatch(/the payer must unapply the payment and apply it again/);
    expect(text).toMatch(/Reason for cancellation:$/);
  });

  it('any other receipt: the reason only', async () => {
    expect(await cancelPrompt('EFT 123')).toBe('Reason for cancellation:');
    cleanup();
    expect(await cancelPrompt(undefined)).toBe('Reason for cancellation:');
  });
});
