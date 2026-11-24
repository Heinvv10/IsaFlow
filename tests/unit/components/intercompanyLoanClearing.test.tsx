// Supplier bill detail, P4-E: "Clear against the intercompany loan". Shown only for a bill linked on a loan connection with the dark flag on
// (the preview 403s with the flag off: nothing shows). The dialog previews DR Accounts Payable / CR the loan account, the amount (the open
// amount, editable down to a partial clearing), the partner and whether the partner can clear it; Review, then a confirm that says what posts;
// the POST sends back what the preview showed. A refusal shows its sentence (nothing posted); a posted clearing names its payment and journal
// (the result is the PAGE's state: `Harness` holds it as the bill page does). The amount is a MoneyField: typed, then committed on blur.
import { useState } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();

import { apiFetch } from '@/lib/apiFetch';
import { LoanClearingPanel } from '@/components/accounting/intercompany/LoanClearingPanel';
import type { LoanClearingPreview, LoanClearResult } from '@/modules/accounting/services/intercompany/payerLoanClearTypes';
import { formatCurrency } from '@/utils/formatters';
import { envelope, failure } from './intercompanyFixtures';

const preview = (over: Partial<LoanClearingPreview> = {}): LoanClearingPreview => ({
  linked: true, billId: 'bill-1', billNumber: 'BILL-77', billDate: '2026-09-01', linkId: 'link-1', partnerName: 'Velocity Fibre',
  loanAccountId: 'loan-1', loanAccountLabel: '2800 Loan from Velocity', payableAccountId: 'ap-1', payableLabel: '2000 Accounts Payable', openAmount: 1150, maxAmount: 1150,
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
const onCleared = vi.fn();
/** The panel as the bill page holds it: the page keeps the clearing's result. */
function Harness({ billId = 'bill-1' }: { billId?: string }) {
  const [cleared, setCleared] = useState<LoanClearResult | null>(null);
  return <LoanClearingPanel billId={billId} cleared={cleared} onCleared={(out) => { setCleared(out); onCleared(out); }} />;
}
async function open() {
  render(<Harness />);
  fireEvent.click(await screen.findByRole('button', { name: BUTTON }));
  return screen.findByRole('dialog', { name: BUTTON });
}
/** Type into the MoneyField and commit it (blur), as a person tabbing on does. */
function setAmount(dialog: HTMLElement, text: string) {
  const field = within(dialog).getByLabelText('Amount');
  fireEvent.change(field, { target: { value: text } });
  fireEvent.blur(field);
}
const bodyOf = (n: number) => JSON.parse(String((posts()[n]![1] as RequestInit).body)) as { amount: number; expected: Record<string, unknown> };

describe('Clear against the intercompany loan', () => {
  it('nothing shows with the flag off (403) or for a bill not linked on a loan connection', async () => {
    answer = { get: () => failure('Clearing intercompany payments against the loan account is not enabled for this company.', 403) };
    const { unmount } = render(<Harness />);
    await waitFor(() => expect(previews()).toBe(1));
    expect(screen.queryByRole('button', { name: BUTTON })).toBeNull();
    unmount();
    answer = { get: () => envelope(preview({ linked: false })) };
    render(<Harness />);
    await waitFor(() => expect(previews()).toBe(2));
    expect(screen.queryByRole('button', { name: BUTTON })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Intercompany loan' })).toBeNull();
  });

  it('previews both legs, the amount, the partner and its readiness; Review, then a confirm; the POST sends what was shown; the ids are shown', async () => {
    answer = {
      get: () => envelope(preview()),
      post: () => envelope({ cleared: true, billId: 'bill-1', paymentId: 'pay-1', paymentNumber: 'SP-00042', journalEntryId: 'je-9', messageId: 'm-1' }),
    };
    const dialog = await open();
    const shown = within(dialog).getByTestId('loan-clearing-preview').textContent ?? '';
    for (const text of ['2000 Accounts Payable', '2800 Loan from Velocity', formatCurrency(1150), 'Velocity Fibre']) expect(shown).toContain(text);
    expect(shown).toMatch(/can clear against its loan account/i);
    expect((within(dialog).getByLabelText('Amount') as HTMLInputElement).value.replace(/\D/g, '')).toBe('115000');
    setAmount(dialog, '400');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Review clearing' }));
    expect(within(dialog).getByTestId('loan-clearing-confirm').textContent).toMatch(/debit 2000 Accounts Payable, credit 2800 Loan from Velocity/);
    expect(posts()).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Post clearing' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    const [url, init] = posts()[0]!;
    expect(String(url)).toBe('/api/accounting/intercompany/loan-clearings');
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      billId: 'bill-1', amount: 400, postingDate: '2026-09-10', expected: { loanAccountId: 'loan-1', linkId: 'link-1', amount: 400, openAmount: 1150, payableAccountId: 'ap-1' },
    });
    expect(await screen.findByText(/SP-00042/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /journal/i })).toHaveAttribute('href', '/accounting/journal-entries/je-9');
    expect(onCleared).toHaveBeenCalled();
  });

  it('an amount above what is open is refused in the dialog, before any request', async () => {
    answer = { get: () => envelope(preview()) };
    const dialog = await open();
    setAmount(dialog, '2000');
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

  it('a 409 (the books changed) fetches the preview again: the sentence stays, and the retry sends what the books now say', async () => {
    let served = 0;
    answer = {
      get: () => envelope(served++ === 0 ? preview() : preview({ openAmount: 1000, maxAmount: 1000 })),
      post: (body) => ((body as { expected: { openAmount: number } }).expected.openAmount === 1150
        ? failure('The bill, its link, your loan account or the Accounts Payable control changed since the preview. Nothing was posted: review the clearing again.', 409)
        : envelope({ cleared: true, billId: 'bill-1', paymentId: 'pay-2', paymentNumber: 'SP-00043', journalEntryId: 'je-10', messageId: 'm-2' })),
    };
    const dialog = await open();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Review clearing' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Post clearing' }));
    expect(await within(dialog).findByText(/changed since the preview/)).toBeInTheDocument();
    await waitFor(() => expect(previews()).toBe(2));
    await waitFor(() => expect((within(dialog).getByLabelText('Amount') as HTMLInputElement).value.replace(/\D/g, '')).toBe('100000'));
    expect(within(dialog).getByText(/changed since the preview/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Review clearing' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Post clearing' }));
    expect(await screen.findByText(/SP-00043/)).toBeInTheDocument();
    expect(bodyOf(1).expected).toMatchObject({ openAmount: 1000, amount: 1000 });
  });

  it('a refusal other than 409 does not fetch the preview again', async () => {
    answer = { get: () => envelope(preview()), post: () => failure('The posting date is in a closed or locked financial period.', 400) };
    const dialog = await open();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Review clearing' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Post clearing' }));
    expect(await within(dialog).findByText(/closed or locked financial period/)).toBeInTheDocument();
    expect(previews()).toBe(1);
  });

  it('blocked by something else, the partner still reads ready when the preflight said so (E)', async () => {
    answer = { get: () => envelope(preview({ receiverReady: true, blocked: 'Not cleared: an approval rule applies to payments of this size.' })) };
    const dialog = await open();
    expect(within(dialog).getByTestId('loan-clearing-preview').textContent).toMatch(/can clear against its loan account/i);
    expect(within(dialog).getByRole('button', { name: 'Review clearing' })).toBeDisabled();
  });

  it('MED-3: the partner ready for less than the bill: the full amount is refused, a smaller one posts (the amount stays editable)', async () => {
    const NOT_READY = 'The partner company cannot clear this against its loan account yet. Nothing was posted.';
    answer = {
      get: () => envelope(preview()),
      post: (body) => ((body as { amount: number }).amount > 400 ? failure(NOT_READY, 409)
        : envelope({ cleared: true, billId: 'bill-1', paymentId: 'pay-3', paymentNumber: 'SP-00044', journalEntryId: 'je-11', messageId: 'm-3' })),
    };
    const dialog = await open();
    expect(within(dialog).getByTestId('loan-clearing-preview').textContent).toMatch(/checked when you post/);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Review clearing' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Post clearing' }));
    expect(await within(dialog).findByText(NOT_READY)).toBeInTheDocument();
    await waitFor(() => expect(previews()).toBe(2));
    expect(within(dialog).getByLabelText('Amount')).not.toBeDisabled();
    setAmount(dialog, '400');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Review clearing' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Post clearing' }));
    expect(await screen.findByText(/SP-00044/)).toBeInTheDocument();
    expect(bodyOf(1)).toMatchObject({ amount: 400, expected: { amount: 400 } });
  });

  it('8e: Review moves the focus to Post clearing; a refusal moves it to the sentence', async () => {
    answer = { get: () => envelope(preview()), post: () => failure('The posting date is in a closed or locked financial period.', 400) };
    const dialog = await open();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Review clearing' }));
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Post clearing' })));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Post clearing' }));
    const sentence = await within(dialog).findByText(/closed or locked financial period/);
    await waitFor(() => expect(document.activeElement).toBe(sentence));
  });

  it('round 3 (e): the SAME refusal again takes the focus back to the sentence; Back returns it to the amount', async () => {
    answer = { get: () => envelope(preview()) };
    const dialog = await open();
    setAmount(dialog, '0');
    const review = within(dialog).getByRole('button', { name: 'Review clearing' });
    fireEvent.click(review);
    const sentence = await within(dialog).findByText(/Enter an amount in rand and cents, more than zero/);
    await waitFor(() => expect(document.activeElement).toBe(sentence));
    // the person moves on and presses Review again with the same amount: the same sentence, and the focus must come back to it
    review.focus();
    fireEvent.click(review);
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByText(/Enter an amount in rand and cents, more than zero/)));
    // Back from the confirm step: the focus is on the amount (the field the person came back to change), not lost to the body
    setAmount(dialog, '100');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Review clearing' }));
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Post clearing' })));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Back' }));
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByLabelText('Amount')));
  });

  it("8c: only the latest preview is applied (an older answer that resolves later is dropped)", async () => {
    let releaseOld: (r: Response) => void = () => undefined;
    vi.mocked(apiFetch).mockImplementation(async (url: unknown) => {
      if (String(url).includes('billId=bill-1')) return new Promise<Response>((resolve) => { releaseOld = resolve; });
      if (String(url).includes('billId=bill-2')) return envelope(preview({ billId: 'bill-2', partnerName: 'Blitz Fibre' }));
      return envelope([]);
    });
    const { rerender } = render(<Harness billId="bill-1" />);
    rerender(<Harness billId="bill-2" />);
    expect(await screen.findByText(/Blitz Fibre/)).toBeInTheDocument();
    releaseOld(envelope(preview({ partnerName: 'Stale Partner' })));
    await new Promise((r) => { setTimeout(r, 20); });
    expect(screen.queryByText(/Stale Partner/)).toBeNull();
    expect(screen.getByText(/Blitz Fibre/)).toBeInTheDocument();
  });
});
