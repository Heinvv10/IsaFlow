/**
 * W1-02 (BNK-05, PUR-09, LED-17, PUR-08): four pages guessed the response
 * envelope instead of reading the shape the route actually sends.
 * Real apiFetch/apiJson run; only the network (global fetch) is stubbed.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ImportPdfPage from '@/../pages/accounting/bank/statements/import-pdf';
import CaptureSettingsPage from '@/../pages/accounting/capture/settings';
import ValidatePage from '@/../pages/accounting/migration/validate';
import DocumentDetailPage from '@/../pages/accounting/document-capture/[docId]';

let query: Record<string, string> = {};
vi.mock('next/router', () => ({
  useRouter: () => ({ query, push: vi.fn(), replace: vi.fn(), pathname: '/', isReady: true }),
}));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('@/components/accounting/capture/WhatsAppVerificationSection', () => ({ WhatsAppVerificationSection: () => null }));
vi.mock('@/components/accounting/capture/CaptureApiKeysSection', () => ({ CaptureApiKeysSection: () => null }));

const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });

function stubFetch(handler: (url: string) => unknown) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ok(handler(String(url)))));
}

beforeEach(() => { query = {}; });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('BNK-05: import-pdf bank account option is labelled with accountName', async () => {
  stubFetch(() => [{ id: 'a1', accountCode: '1110', accountName: 'FNB Cheque', bankAccountNumber: '62001234' }]);
  render(<ImportPdfPage />);
  expect(await screen.findByRole('option', { name: /FNB Cheque/ })).toBeInTheDocument();
});

it('PUR-09: capture settings shows the forwarding address from data.inbox.address', async () => {
  stubFetch((url) => url.includes('inbox-address')
    ? { inbox: { id: 'i1', address: 'cap-123@inbox.isaflow.co.za', isActive: true } }
    : { chaseAutoSendEnabled: false, chaseGraceDays: 3, whatsappChaseEnabled: false });
  render(<CaptureSettingsPage />);
  expect(await screen.findByText('cap-123@inbox.isaflow.co.za')).toBeInTheDocument();
});

it('LED-17: migration validate says so when there is no active session', async () => {
  stubFetch(() => ({ session: null }));
  render(<ValidatePage />);
  expect(await screen.findByText(/No active migration session/)).toBeInTheDocument();
});

it('LED-17: migration validate reads session.id when a session exists', async () => {
  const seen: string[] = [];
  stubFetch((url) => {
    seen.push(url);
    return url.includes('/migration/session')
      ? { session: { id: 'sess-9', status: 'in_progress' } }
      : { sessionId: 'sess-9', checks: [], allPassed: true };
  });
  render(<ValidatePage />);
  await waitFor(() => expect(seen.some((u) => u.includes('sessionId=sess-9'))).toBe(true));
});

it('PUR-08: a document outside the newest 25 loads by id', async () => {
  query = { docId: 'doc-old' };
  const doc = {
    id: 'doc-old', fileName: 'shell-receipt.png', fileType: 'png', fileSize: 10, documentType: 'receipt',
    extractedData: null, vendorName: 'Shell Garage Pretoria', documentDate: null, referenceNumber: null,
    totalAmount: 100, vatAmount: 15, status: 'pending', matchedInvoiceId: null, matchedBankTxId: null,
    notes: null, uploadedBy: null, createdAt: '2026-04-25T00:00:00.000Z',
  };
  stubFetch((url) => url.includes('id=doc-old')
    ? doc
    : Array.from({ length: 25 }, (_, i) => ({ ...doc, id: `newer-${i}` })));
  render(<DocumentDetailPage />);
  expect(await screen.findByDisplayValue('Shell Garage Pretoria')).toBeInTheDocument();
  expect(screen.queryByText(/Document not found/)).not.toBeInTheDocument();
});
