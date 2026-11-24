// Supplier bill detail, P4-E: "Clear against the intercompany loan". Shown only for a bill linked on a loan connection with the dark flag on
// (the preview 403s with the flag off: nothing shows). The dialog previews DR Accounts Payable / CR the loan account, the amount (the open
// amount, editable down to a partial clearing), the partner and whether the partner can clear it; Review, then a confirm that says what posts;
// the POST sends back what the preview showed. A refusal shows its sentence (nothing posted); a posted clearing names its payment and journal.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();

import { apiFetch } from '@/lib/apiFetch';
import { LoanClearingPanel } from '@/components/accounting/intercompany/LoanClearingPanel';
import type { LoanClearingPreview } from '@/modules/accounting/services/intercompany/payerLoanClearTypes';
import { formatCurrency } from '@/utils/formatters';
import { envelope, failure } from './intercompanyFixtures';

const preview = (over: Partial<LoanClearingPreview> = {}): LoanClearingPreview => ({
  linked: true, billId: 'bill-1', billNumber: 'BILL-77', billDate: '2026-09-01', linkId: 'link-1', partnerName: 'Velocity Fibre',
  loanAccountId: 'loan-1', loanAccountLabel: '2800 Loan from Velocity', payableLabel: '2000 Accounts Payable', openAmount: 1150, maxAmount: 1150,
  floorDate: '2026-09-01', defaultPostingDate: '2026-09-10', receiverReady: true, blocked: null, ...over,
});

let answer: { get: () => Response; post?: (body: unknown) => Response };
const posts = () => vi.mocked(apiFetch).mock.calls.filter(([, i]) => (i as RequestInit | undefined)?.method === 'POST');
const previews = () => vi.mocked(apiFetch).mock.calls.filter(([u]) => String(u).includes('/loan-clearings?billId=bill-1')).length;
beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
  vi.mocked(apiFetch).mockImplementation(async (url: unknown, init?: unknown) => {
    const i = init as RequestInit | undefined;
    if (i?.method === 'POST') return answer.post?.(JSON.parse(String(i.body))) ?? envelope({});
    // the date field asks for the fiscal periods; only the preview is this route's
    return String(url).includes('/loan-clearings?') ? answer.get() : envelope([]);
  });
});
afterEach(() => { vi.restoreAllMocks(); });

const BUTTON = 'Clear against the intercompany loan';
async function open() {
  render(<LoanClearingPanel billId="bill-1" onCleared={onCleared} />);
  fireEvent.click(await screen.findByRole('button', { name: BUTTON }));
  return screen.findByRole('dialog', { name: BUTTON });
}
const onCleared = vi.fn();

describe('Clear against the intercompany loan', () => {
  it('nothing shows with the flag off (403) or for a bill not linked on a loan connection', async () => {
    answer = { get: () => failure('Clearing intercompany payments against the loan account is not enabled for this company.', 403) };
    const { unmount } = render(<LoanClearingPanel billId="bill-1" onCleared={onCleared} />);
    await waitFor(() => expect(previews()).toBe(1));
    expect(screen.queryByRole('button', { name: BUTTON })).toBeNull();
    unmount();
    answer = { get: () => envelope(preview({ linked: false })) };
    render(<LoanClearingPanel billId="bill-1" onCleared={onCleared} />);
    await waitFor(() => expect(previews()).toBe(2));
    expect(screen.queryByRole('button', { name: BUTTON })).toBeNull();
  });

  it('previews both legs, the amount, the partner and its readiness; Review, then a confirm; the POST sends what was shown; the ids are shown', async () => {
    answer = {
      get: () => envelope(preview()),
      post: () => envelope({ cleared: true, billId: 'bill-1', paymentId: 'pay-1', paymentNumber: 'SP-00042', journalEntryId: 'je-9', messageId: 'm-1' }),
    };
    const dialog = await open();
    const shown = within(dialog).getByTestId('loan-clearing-preview').textContent ?? '';
    for (const text of ['2000 Accounts Payable', '2800 Loan from Velocity', formatCurrency(1150), 'Velocity Fibre']) expect(shown).toContain(text);
    expect(shown).toMatch(/can clear it/i);
    const amount = within(dialog).getByLabelText('Amount') as HTMLInputElement;
    expect(amount.value).toBe('1150');
    fireEvent.change(amount, { target: { value: '400' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Review clearing' }));
    expect(within(dialog).getByTestId('loan-clearing-confirm').textContent).toMatch(/debit 2000 Accounts Payable, credit 2800 Loan from Velocity/);
    expect(posts()).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Post clearing' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    const [url, init] = posts()[0]!;
    expect(String(url)).toBe('/api/accounting/intercompany/loan-clearings');
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      billId: 'bill-1', amount: 400, postingDate: '2026-09-10', expected: { loanAccountId: 'loan-1', linkId: 'link-1', amount: 400, openAmount: 1150 },
    });
    expect(await screen.findByText(/SP-00042/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /journal/i })).toHaveAttribute('href', '/accounting/journal-entries/je-9');
    expect(onCleared).toHaveBeenCalled();
  });

  it('an amount above what is open is refused in the dialog, before any request', async () => {
    answer = { get: () => envelope(preview()) };
    const dialog = await open();
    fireEvent.change(within(dialog).getByLabelText('Amount'), { target: { value: '2000' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Review clearing' }));
    expect(within(dialog).queryByTestId('loan-clearing-confirm')).toBeNull();
    expect(within(dialog).getByRole('alert').textContent).toMatch(/open/i);
    expect(posts()).toHaveLength(0);
  });

  it('the partner not ready (or another block): the sentence shows and Review is disabled', async () => {
    answer = { get: () => envelope(preview({ receiverReady: false, blocked: 'The partner company cannot clear this against its loan account yet. Nothing was posted.' })) };
    const dialog = await open();
    expect(within(dialog).getByText(/partner company cannot clear this/)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Review clearing' })).toBeDisabled();
  });

  it("a refusal shows the server's sentence, keeps the dialog open and posts nothing more", async () => {
    answer = { get: () => envelope(preview()), post: () => failure('The bill changed since the preview. Nothing was posted: review the clearing again.', 409) };
    const dialog = await open();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Review clearing' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Post clearing' }));
    expect(await within(dialog).findByText(/changed since the preview/)).toBeInTheDocument();
    expect(posts()).toHaveLength(1);
  });
});
