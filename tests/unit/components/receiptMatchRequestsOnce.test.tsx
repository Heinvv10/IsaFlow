/**
 * receipt-match asks for each receipt's shortlist once. The effect that loads them is keyed on the shortlists
 * map, which only fills when a response lands, so on a slow API every arriving response re-requested all the
 * rows still waiting: with 50 rows that is ~700 requests per page load, which starves the shell's own fetches
 * (the company switcher skeleton stayed up for over a minute under a 3 s API delay).
 */
import { cleanup, configure, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, push: vi.fn(), replace: vi.fn(), pathname: '/' }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

import { apiFetch } from '@/lib/apiFetch';
import ReceiptMatchPage from '../../../pages/accounting/ar/receipt-match/index';
import { ok } from '../helpers/d2CensusG4';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
afterEach(() => { cleanup(); });

const ROWS = ['tx-1', 'tx-2', 'tx-3', 'tx-4'].map((id) => ({ id, transactionDate: '2031-03-01', amount: 500, description: `Row ${id}`, reference: id }));

describe('receipt-match shortlist requests', () => {
  it('requests each row once even though responses arrive one at a time', async () => {
    const waiting = new Map<string, () => void>();
    vi.mocked(apiFetch).mockReset().mockImplementation(async (url: string) => {
      if (url.includes('bank-transactions')) return ok({ transactions: ROWS });
      const id = /receipt-match\/([\w-]+)/.exec(url)?.[1] as string;
      await new Promise<void>((resolve) => waiting.set(id, resolve));
      return ok({ candidates: [], bankTransaction: ROWS.find((r) => r.id === id) });
    });
    render(<ReceiptMatchPage />);
    await vi.waitFor(() => expect(waiting.size).toBe(4));

    // Answer them one by one; each answer re-renders the page and must not re-request the others.
    for (const id of ROWS.map((r) => r.id)) {
      waiting.get(id)?.();
      await screen.findByText(`Row ${id}`);
      await new Promise((r) => setTimeout(r, 20));
    }
    const shortlistCalls = vi.mocked(apiFetch).mock.calls.map(([u]) => String(u)).filter((u) => /receipt-match\/tx-/.test(u));
    expect(shortlistCalls.sort()).toEqual(ROWS.map((r) => `/api/accounting/ar/receipt-match/${r.id}`));
  });
});
