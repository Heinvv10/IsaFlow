// D8 round 6: the dismiss toast repeats the route's message. A provisional whose reversal chain was
// already out of the ledger is dismissed without a contra, so the toast must not claim a reversal.
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

vi.mock('next/link', () => ({ default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/lib/apiFetch', async (original) => ({ ...await original<typeof import('@/lib/apiFetch')>(), apiFetch: vi.fn() }));

import { apiFetch } from '@/lib/apiFetch';
import ProvisionalPage from '../../../pages/accounting/bank/provisional';

const entry = { jeId: 'je-1', bankTxId: 'bt-1', bankAccountName: 'FNB', description: 'Card purchase', amount: -150,
  transactionDate: '2026-09-21', daysOutstanding: 2, predictedSupplierId: null, predictedSupplierName: null,
  predictionConfidence: 0.8, glAccountId: null, glAccountName: null, postedAt: '2026-09-21' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const empty500 = () => new Response('', { status: 500 });
const list = () => json({ success: true, data: { outstanding: [entry] } });

afterEach(() => vi.mocked(apiFetch).mockReset());

async function dismissWith(message: string, bankTransactionsReset: number) {
  vi.mocked(apiFetch).mockImplementation(async (url) => String(url).endsWith('/dismiss')
    ? json({ success: true, data: { reversalJournalEntryId: null, bankTransactionsReset }, message })
    : json({ success: true, data: { outstanding: [entry] } }));
  render(<ProvisionalPage />);
  fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }));
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss & reverse' }));
}

it('an out chain: says the entry was dismissed, not reversed, and that the bank line is back in the queue', async () => {
  await dismissWith('Provisional entry dismissed; its journal was already out of the ledger', 1);
  expect(await screen.findByText('Provisional entry dismissed; its journal was already out of the ledger'
    + ' — linked bank transaction returned to the review queue.')).toBeTruthy();
  expect(screen.queryByText(/Provisional entry reversed/)).toBeNull();
});

it('a standing journal: says it was reversed and that the bank line is back in the queue', async () => {
  await dismissWith('Provisional entry reversed', 1);
  expect(await screen.findByText('Provisional entry reversed — linked bank transaction returned to the review queue.')).toBeTruthy();
});

it('no linked bank line: does not claim one was returned to the queue', async () => {
  await dismissWith('Provisional entry reversed', 0);
  expect(await screen.findByText('Provisional entry reversed.')).toBeTruthy();
  expect(screen.queryByText(/review queue\.$/)).toBeNull();
});

// D8 round 8 (qa-d8): an empty-body 500 used to reach the toast as the browser's JSON SyntaxError.
async function clickDismiss(dismissReply: () => Response) {
  vi.mocked(apiFetch).mockImplementation(async (url) => (String(url).endsWith('/dismiss') ? dismissReply() : list()));
  render(<ProvisionalPage />);
  fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }));
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss & reverse' }));
}

it('dismiss, empty 500: a plain sentence, not a JSON parse error', async () => {
  await clickDismiss(empty500);
  expect(await screen.findByText('Could not dismiss the entry - try again')).toBeTruthy();
  expect(screen.queryByText(/JSON/)).toBeNull();
});

it("dismiss, 400: the server's message", async () => {
  await clickDismiss(() => json({ success: false, error: { code: 'BAD_REQUEST', message: 'Journal entry already reversed' } }, 400));
  expect(await screen.findByText('Journal entry already reversed')).toBeTruthy();
});

it('the list, empty 500: a plain sentence', async () => {
  vi.mocked(apiFetch).mockImplementation(async () => empty500());
  render(<ProvisionalPage />);
  expect(await screen.findByText('Could not load the provisional entries - try again')).toBeTruthy();
});

it("the list, 403: the server's message", async () => {
  vi.mocked(apiFetch).mockImplementation(async () => json({ success: false, error: { code: 'FORBIDDEN', message: 'No access to this company' } }, 403));
  render(<ProvisionalPage />);
  expect(await screen.findByText('No access to this company')).toBeTruthy();
});

it('the captured-document list, empty 500: a plain sentence', async () => {
  vi.mocked(apiFetch).mockImplementation(async (url) => (String(url).includes('document-capture') ? empty500() : list()));
  render(<ProvisionalPage />);
  fireEvent.click(await screen.findByRole('button', { name: 'Attach evidence' }));
  expect(await screen.findByText('Could not load documents - try again')).toBeTruthy();
});

it('attach, empty 500: a plain sentence; 400: the server message', async () => {
  const doc = { id: 'd1', fileName: 'slip.pdf', vendorName: 'Shell', documentDate: '2026-09-21', totalAmount: 150, documentType: 'receipt' };
  let attach: () => Response = empty500;
  vi.mocked(apiFetch).mockImplementation(async (url) => {
    const u = String(url);
    if (u.endsWith('/attach')) return attach();
    return u.includes('document-capture') ? json({ success: true, data: [doc] }) : list();
  });
  render(<ProvisionalPage />);
  fireEvent.click(await screen.findByRole('button', { name: 'Attach evidence' }));
  fireEvent.click(await screen.findByText('Shell'));
  expect(await screen.findByText('Could not attach the evidence - try again')).toBeTruthy();
  attach = () => json({ success: false, error: { code: 'BAD_REQUEST', message: 'Journal entry is already evidenced' } }, 400);
  fireEvent.click(screen.getByText('Shell'));
  expect(await screen.findByText('Journal entry is already evidenced')).toBeTruthy();
});

