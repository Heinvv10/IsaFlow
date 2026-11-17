/**
 * Settled-document evidence on a bank line: the attachments modal and the line drawer list the line's own files first,
 * then, read-only, "From settled bills / invoices" (include_settled=1). A settled document is opened or viewed, never
 * removed; it says what it settles, "part-paid R x of R y" for a part payment; the paperclip count covers both kinds.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/components/accounting/comments/CommentsPanel', () => ({ CommentsPanel: () => null }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { apiFetch } from '@/lib/apiFetch';
import { BankTxAttachmentsModal } from '@/components/accounting/BankTxAttachmentsModal';
import { BankLineDrawerBody } from '@/components/accounting/bank-transactions/BankLineDrawerBody';
import { settledCaption } from '@/components/accounting/bankTx/SettledEvidenceList';
import { formatMoney } from '@/lib/money/formatMoney';
import type { BankTx } from '@/components/accounting/BankTxTable';
import type { Attachment } from '@/components/accounting/bankTxAttachmentHelpers';

useApiJsonOverMock();
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const CAPTURE = '0b1e9b1c-1111-4111-8111-111111111111';

const OWN = { id: 'a1', bank_transaction_id: 'bt-1', file_name: 'slip.png', file_url: 'data:image/png;base64,iVBORw0KGgo=', file_size: 8, uploaded_by: null, created_at: '2026-11-02' };
const settled = (over: Partial<Attachment> & { settles: Attachment['settles'] }): Attachment => ({
  id: `settled:${over.file_name}`, bank_transaction_id: 'bt-1', file_name: 'x.pdf', file_url: 'https://files.test/x.pdf',
  file_size: 100, uploaded_by: null, created_at: '2026-10-20', source: 'settled_document', content_type: 'application/pdf',
  via: { kind: 'supplier_payment', payment_id: 'p1', payment_number: 'SP-1' }, ...over,
});
const BILL = settled({ file_name: 'SIV-1.pdf', file_url: 'https://files.test/SIV-1.pdf',
  settles: { entity_type: 'supplier_invoice', entity_id: 'b1', number: 'SIV-1', total: 1000, applied: 1000, partial: false, invoice_id: 'b1', invoice_number: 'SIV-1' } });
const PART = settled({ file_name: 'SIV-3.pdf',
  settles: { entity_type: 'supplier_invoice', entity_id: 'b3', number: 'SIV-3', total: 1000, applied: 300, partial: true, invoice_id: 'b3', invoice_number: 'SIV-3' } });
const CREDIT = settled({ file_name: 'SCN-1.pdf',
  settles: { entity_type: 'credit_note', entity_id: 'cn', number: 'SCN-1', total: 200, applied: 200, partial: false, invoice_id: 'b4', invoice_number: 'SIV-4' } });
const ISSUED = settled({ file_name: 'INV-1 issued.pdf', file_url: `/api/accounting/captured-document-file?id=${CAPTURE}`,
  via: { kind: 'customer_payment', payment_id: 'cp', payment_number: 'CP-1' },
  settles: { entity_type: 'customer_invoice', entity_id: 'i1', number: 'INV-1', total: 2300, applied: 2300, partial: false, invoice_id: 'i1', invoice_number: 'INV-1' } });

function serve(rows: unknown[]) {
  vi.mocked(apiFetch).mockImplementation(async () => ok(rows));
}
beforeEach(() => { vi.mocked(apiFetch).mockReset(); vi.stubGlobal('confirm', () => true); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('settledCaption', () => {
  it('says what was paid, part-paid R x of R y, and what a credit note offsets', () => {
    const R = formatMoney;
    expect(settledCaption(BILL)).toBe(`Bill SIV-1 · paid ${R(1000)} · via SP-1`);
    expect(settledCaption(PART)).toBe(`Bill SIV-3 · part-paid ${R(300)} of ${R(1000)} · via SP-1`);
    expect(settledCaption(CREDIT)).toBe(`Credit note SCN-1 · ${R(200)} against SIV-4 · via SP-1`);
    expect(settledCaption(ISSUED)).toMatch(/^Invoice INV-1 · paid/);
  });
});

describe('BankTxAttachmentsModal settled evidence', () => {
  it('asks for the settled documents and lists them after the line\'s own, read-only', async () => {
    serve([OWN, BILL, PART]);
    const onCount = vi.fn();
    render(<BankTxAttachmentsModal bankTransactionId="bt-1" onCountChange={onCount} onClose={() => undefined} />);
    const section = await screen.findByRole('region', { name: 'From settled bills and invoices' });
    expect(String(vi.mocked(apiFetch).mock.calls[0]![0])).toBe('/api/accounting/bank-tx-attachments?bankTransactionId=bt-1&include_settled=1');
    expect(within(section).getByText('SIV-1.pdf')).toBeTruthy();
    expect(within(section).getByText(/part-paid/)).toBeTruthy();
    // Opened in a new tab; no Remove in the section; the own file keeps its Remove.
    expect(within(section).getByRole('link', { name: 'Open SIV-1.pdf' }).getAttribute('href')).toBe('https://files.test/SIV-1.pdf');
    expect(within(section).queryByRole('button', { name: /Remove/ })).toBeNull();
    expect(screen.getAllByRole('button', { name: /Remove/ })).toHaveLength(1);
    // The paperclip counts both kinds; the footer still counts the line's own.
    expect(onCount).toHaveBeenLastCalledWith(3);
    expect(screen.getByText('1 attachment')).toBeTruthy();
  });

  it('shows the settled list, not "No attachments yet", for a line with no file of its own', async () => {
    serve([BILL]);
    render(<BankTxAttachmentsModal bankTransactionId="bt-1" onClose={() => undefined} />);
    expect(await screen.findByText('SIV-1.pdf')).toBeTruthy();
    expect(screen.queryByText('No attachments yet')).toBeNull();
  });

  it('views a settled captured PDF in the viewer, and keeps the settled count after a remove', async () => {
    serve([OWN, ISSUED]);
    const onCount = vi.fn();
    render(<BankTxAttachmentsModal bankTransactionId="bt-1" onCountChange={onCount} onClose={() => undefined} />);
    expect(await screen.findByRole('button', { name: 'View INV-1 issued.pdf' })).toBeTruthy();
    vi.mocked(apiFetch).mockImplementation(async () => ok({ deleted: 'a1' }));
    fireEvent.click(screen.getByRole('button', { name: /Remove/ }));
    await vi.waitFor(() => expect(onCount).toHaveBeenLastCalledWith(1));
  });
});

describe('BankLineDrawerBody settled evidence', () => {
  const TX: BankTx = { id: 'tx-1', transactionDate: '2026-11-02', description: 'ABSA BANK CFS', amount: -1500, status: 'allocated', attachmentCount: 2 };
  it('lists the line\'s own file, then the settled bills, without a false truncation notice', async () => {
    vi.mocked(apiFetch).mockImplementation(async (url) => (String(url).includes('bank-tx-attachments') ? ok([OWN, BILL]) : ok(null)));
    render(<BankLineDrawerBody tx={TX} />);
    const section = await screen.findByRole('region', { name: 'From settled bills and invoices' });
    expect(within(section).getByText('SIV-1.pdf')).toBeTruthy();
    expect(screen.getByText('slip.png')).toBeTruthy();
    expect(screen.queryByTestId('attachments-truncated')).toBeNull();
  });
});
