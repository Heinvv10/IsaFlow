// Bills > Intercompany, "Payments from your group", P4-D: Accept from the drawer. The preview names the debit (this company's loan account),
// the credit (Accounts Receivable), the amount, the invoice, the payment date, and proposes a posting date; Review then a confirm that says what
// posts; the POST sends back what the preview showed and the chosen date. A refusal shows the stored sentence (nothing posted) and reloads; a
// 409 closes the dialog (the preview is out of date). A handled row names its clearing receipt and says "Clearing voided" when it was voided.
// A viewer has no Accept.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

const h = vi.hoisted(() => ({ role: 'owner' as string }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: h.role }) }));
vi.mock('next/router', () => ({ useRouter: () => ({ push: vi.fn(), query: {}, pathname: '/accounting/supplier-invoices/intercompany' }) }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();

import { apiFetch } from '@/lib/apiFetch';
import IntercompanyInboxPage from '../../../pages/accounting/supplier-invoices/intercompany';
import { formatCurrency } from '@/utils/formatters';
import { envelope, failure } from './intercompanyFixtures';
import { alloc, detailOf, posts, previewOf, serve } from './intercompanyInboxFixtures';

beforeEach(() => { h.role = 'owner'; vi.mocked(apiFetch).mockReset(); });
afterEach(() => { vi.restoreAllMocks(); });

const LABEL = 'payment SP-00012 on INV-900';
const section = () => screen.findByRole('region', { name: 'Payments from your group' });
const allocationsLoads = () => vi.mocked(apiFetch).mock.calls.filter(([u]) => String(u).includes('/allocations?filter=open')).length;

async function openAccept() {
  render(<IntercompanyInboxPage />);
  fireEvent.click(within(await section()).getByRole('button', { name: `Details for ${LABEL}` }));
  const drawer = await screen.findByRole('dialog');
  const button = within(drawer).getByRole('button', { name: `Accept ${LABEL}` });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  return screen.findByRole('dialog', { name: `Clear ${LABEL}` });
}

describe('Accept a payment from the group', () => {
  it('previews both legs, the amount, the invoice and proposes the posting date; Review, then a confirm that says what posts; the POST sends what was shown', async () => {
    serve({ items: [], allocations: [alloc()], post: () => envelope({ accepted: true, messageId: 'a-1', paymentId: 'p-1', paymentNumber: 'CP-00031', journalEntryId: 'je-1' }) });
    const dialog = await openAccept();
    const preview = within(dialog).getByTestId('allocation-accept-preview');
    for (const text of ['1400 Loan to Velocity', '1200 Accounts Receivable', formatCurrency(1150), 'INV-900']) expect(preview.textContent).toContain(text);
    const date = within(dialog).getByLabelText('Posting date') as HTMLInputElement;
    expect(date.value).toMatch(/^0?1 Sep 2026$/);   // the proposed date (the payment date), shown as the app shows dates
    fireEvent.change(date, { target: { value: '2026-09-10' } });
    fireEvent.blur(date);
    expect(posts()).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Review clearing' }));
    expect(within(dialog).getByTestId('allocation-accept-confirm').textContent).toMatch(/debit 1400 Loan to Velocity, credit 1200 Accounts Receivable, against invoice INV-900/);
    expect(posts()).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Post clearing' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    const [url, init] = posts()[0]!;
    expect(String(url)).toBe('/api/accounting/intercompany/allocations/a-1/accept');
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ expectedLoanAccountId: 'loan-1', invoiceId: 'inv-1', amount: 1150, postingDate: '2026-09-10' });
    expect(await screen.findByText(`Cleared ${LABEL}: receipt CP-00031 posted.`)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: `Clear ${LABEL}` })).toBeNull());
  });

  it('a date before the payment is refused in the dialog, before any request', async () => {
    serve({ items: [], allocations: [alloc()] });
    const dialog = await openAccept();
    const date = within(dialog).getByLabelText('Posting date');
    fireEvent.change(date, { target: { value: '2026-08-31' } });
    fireEvent.blur(date);
    expect(await within(dialog).findByText('The posting date must be on or after the payment date.')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Review clearing' }));
    expect(within(dialog).queryByTestId('allocation-accept-confirm')).toBeNull();
    expect(posts()).toHaveLength(0);
  });

  it('a refusal shows the sentence stored on the message, keeps the dialog open and reloads the list', async () => {
    const sentence = 'The posting date is in a closed or locked financial period. Choose a date in an open period. Nothing was posted.';
    serve({ items: [], allocations: [alloc()], post: () => envelope({ accepted: false, messageId: 'a-1', status: 'failed', code: 'period_locked', error: sentence }) });
    const dialog = await openAccept();
    const before = allocationsLoads();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Review clearing' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Post clearing' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(sentence);
    await waitFor(() => expect(allocationsLoads()).toBeGreaterThan(before));
    expect(screen.getByRole('dialog', { name: `Clear ${LABEL}` })).toBeInTheDocument();
  });

  it('a 409 (the books changed since the preview) closes the dialog with its sentence and reloads', async () => {
    const sentence = 'Your loan account on the connection changed since the preview. Nothing was posted: review the clearing again.';
    serve({ items: [], allocations: [alloc()], post: () => failure(sentence, 409) });
    const dialog = await openAccept();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Review clearing' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Post clearing' }));
    expect(await screen.findByText(sentence)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: `Clear ${LABEL}` })).toBeNull());
  });

  it('no loan account on the connection: the dialog says so and cannot be reviewed', async () => {
    const item = alloc();
    serve({ items: [], allocations: [item], allocationDetail: detailOf(item, previewOf(item, { loanAccountId: null, loanAccountLabel: null })) });
    const dialog = await openAccept();
    expect(dialog.textContent).toMatch(/Set your loan account on the connection first/);
    expect(within(dialog).getByRole('button', { name: 'Review clearing' })).toBeDisabled();
  });

  it('a failed message says why it was not cleared; a viewer has no Accept', async () => {
    h.role = 'viewer';
    const failed = alloc({ status: 'failed', error: 'This payment is already cleared. Nothing was posted.' });
    serve({ items: [], allocations: [failed] });
    render(<IntercompanyInboxPage />);
    const s = await section();
    expect(s.textContent).toContain('Not cleared: This payment is already cleared. Nothing was posted.');
    fireEvent.click(within(s).getByRole('button', { name: `Details for ${LABEL}` }));
    const drawer = await screen.findByRole('dialog');
    await within(drawer).findByTestId('allocation-failed-error');
    expect(within(drawer).queryByRole('button', { name: /accept/i })).toBeNull();
  });
});

describe('a handled payment', () => {
  it('names its clearing receipt, and says "Clearing voided" only when that receipt was voided', async () => {
    const cleared = alloc({ id: 'a-1', status: 'accepted', clearedBy: { paymentId: 'p-1', paymentNumber: 'CP-00031', journalEntryId: 'je-1', voided: false } });
    const voided = alloc({ id: 'a-2', paymentNumber: 'SP-00013', status: 'accepted', clearedBy: { paymentId: 'p-2', paymentNumber: 'CP-00032', journalEntryId: 'je-2', voided: true } });
    serve({ items: [], allocations: [cleared, voided] });
    render(<IntercompanyInboxPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Handled' }));
    const rows = within(await section()).getAllByTestId('allocation-row');
    expect(rows[0]!.textContent).toContain('Receipt CP-00031');
    expect(within(rows[0]!).queryByTestId('allocation-voided')).toBeNull();
    expect(rows[1]!.textContent).toContain('Receipt CP-00032');
    expect(within(rows[1]!).getByTestId('allocation-voided')).toHaveTextContent('Clearing voided');
    fireEvent.click(within(rows[1]!).getByRole('button', { name: /Details for payment SP-00013/ }));
    const drawer = await screen.findByRole('dialog');
    expect(within(drawer).getByTestId('allocation-cleared-by').textContent).toMatch(/Cleared by receipt CP-00032.*Clearing voided/);
    expect(within(drawer).queryByRole('button', { name: /accept/i })).toBeNull();
  });
});
