// The attach modal asked for `?status=extracted`, a status a captured document never has, so it always
// listed nothing. It now asks the API for the documents the attach accepts (`attachable=1`).
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
const doc = { id: 'd1', fileName: 'slip.pdf', vendorName: 'Shell', documentDate: '2026-09-21', totalAmount: 150, documentType: 'receipt' };
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

afterEach(() => vi.mocked(apiFetch).mockReset());

it('the attach modal asks for attachable documents and lists them', async () => {
  vi.mocked(apiFetch).mockImplementation(async (url) => (String(url).includes('document-capture')
    ? json({ success: true, data: [doc] }) : json({ success: true, data: { outstanding: [entry] } })));
  render(<ProvisionalPage />);
  fireEvent.click(await screen.findByRole('button', { name: 'Attach evidence' }));
  expect(await screen.findByText('Shell')).toBeTruthy();
  const asked = vi.mocked(apiFetch).mock.calls.map(([u]) => String(u)).filter((u) => u.includes('document-capture'));
  expect(asked).toHaveLength(1);
  const params = new URL(asked[0]!, 'http://x').searchParams;
  expect(params.get('attachable')).toBe('1');
  expect(params.has('status')).toBe(false);
});
