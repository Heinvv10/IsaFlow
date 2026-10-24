// The attach modal fetches 50 documents a page; "Load more" fetches the next page by the server's keyset cursor and appends it, and goes away
// once everything the server counted is loaded.
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
const doc = (n: number) => ({ id: `d${n}`, fileName: `slip${n}.pdf`, vendorName: `Vendor ${n}`, documentDate: '2026-09-21', totalAmount: 10 * n, documentType: 'receipt' });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const docsUrls = () => vi.mocked(apiFetch).mock.calls.map(([u]) => String(u)).filter((u) => u.includes('document-capture'));

afterEach(() => vi.mocked(apiFetch).mockReset());

async function open(docsPage: (after: string | null) => Response) {
  vi.mocked(apiFetch).mockImplementation(async (url) => {
    const u = String(url);
    if (!u.includes('document-capture')) return json({ success: true, data: { outstanding: [entry] } });
    return docsPage(new URL(u, 'http://x').searchParams.get('after'));
  });
  render(<ProvisionalPage />);
  fireEvent.click(await screen.findByRole('button', { name: 'Attach evidence' }));
}

// The server's cursor for the last row of page 1: the modal must hand it back untouched.
const CURSOR = '2026-09-21T10:00:00.123456Z,d50';
const first = Array.from({ length: 50 }, (_, i) => i + 1);
const page = (after: string | null) => (after === null
  ? json({ success: true, data: first.map(doc), pagination: { page: 1, pageSize: 50, total: 53 }, meta: { nextAfter: CURSOR } })
  : json({ success: true, data: [51, 52, 53].map(doc), pagination: { page: 1, pageSize: 50, total: 53 }, meta: { nextAfter: '2026-09-20T10:00:00.000001Z,d53' } }));

it('Load more fetches the next page, appends it, and hides once all 53 are loaded', async () => {
  await open(page);
  expect(await screen.findByText('Vendor 1')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
  expect(await screen.findByText('Vendor 53')).toBeTruthy();
  expect(screen.getByText('Vendor 1')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  const second = new URL(docsUrls()[1]!, 'http://x').searchParams;
  expect(second.get('after')).toBe(CURSOR);
  expect(second.has('page')).toBe(false);
  expect(second.get('attachable')).toBe('1');
});

it('no Load more when everything fits in the first page', async () => {
  await open(() => json({ success: true, data: [doc(1)], pagination: { page: 1, pageSize: 50, total: 1 }, meta: { nextAfter: 'x,d1' } }));
  expect(await screen.findByText('Vendor 1')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
});

it('a failed Load more keeps the loaded documents, says so, and can be tried again', async () => {
  let second = 0;
  await open((after) => (after !== null && ++second === 1 ? new Response('', { status: 500 }) : page(after)));
  expect(await screen.findByText('Vendor 1')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
  expect(await screen.findByText('Could not load documents - try again')).toBeTruthy();
  expect(screen.getByText('Vendor 1')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
  expect(await screen.findByText('Vendor 53')).toBeTruthy();
  expect(screen.queryByText('Could not load documents - try again')).toBeNull();
});
