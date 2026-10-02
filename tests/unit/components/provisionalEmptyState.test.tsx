// D8 round 14 (qa-d8b browser proof): a failed load showed its error AND the empty state beneath it, which says there
// is nothing to do. The list and the attach modal's document list show the empty state only when the load succeeded
// with nothing in it; a failed load shows the failure alone.
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
const NO_ENTRIES = /No provisional entries awaiting evidence/;
const NO_DOCS = /No extracted documents found/;

afterEach(() => vi.mocked(apiFetch).mockReset());

it('the list fails to load: the error, and no "nothing awaiting evidence" beneath it', async () => {
  vi.mocked(apiFetch).mockImplementation(async () => empty500());
  render(<ProvisionalPage />);
  expect(await screen.findByText('Could not load the provisional entries - try again')).toBeTruthy();
  expect(screen.queryByText(NO_ENTRIES)).toBeNull();
});

it('the list loads empty: the empty state, and no error', async () => {
  vi.mocked(apiFetch).mockImplementation(async () => json({ success: true, data: { outstanding: [] } }));
  render(<ProvisionalPage />);
  expect(await screen.findByText(NO_ENTRIES)).toBeTruthy();
  expect(screen.queryByText(/Could not load/)).toBeNull();
});

async function openAttachWith(docs: () => Response) {
  vi.mocked(apiFetch).mockImplementation(async (url) => (String(url).includes('document-capture')
    ? docs() : json({ success: true, data: { outstanding: [entry] } })));
  render(<ProvisionalPage />);
  fireEvent.click(await screen.findByRole('button', { name: 'Attach evidence' }));
}

it('the attach modal\'s document list fails to load: the failure in the modal, not "no extracted documents"', async () => {
  await openAttachWith(empty500);
  expect(await screen.findByText('Could not load documents - try again')).toBeTruthy();
  expect(screen.queryByText(NO_DOCS)).toBeNull();
});

it('the attach modal\'s document list loads empty: "no extracted documents", and no error', async () => {
  await openAttachWith(() => json({ success: true, data: [] }));
  expect(await screen.findByText(NO_DOCS)).toBeTruthy();
  expect(screen.queryByText(/Could not load/)).toBeNull();
});
