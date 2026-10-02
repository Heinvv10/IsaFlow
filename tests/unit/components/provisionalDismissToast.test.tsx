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
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

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
