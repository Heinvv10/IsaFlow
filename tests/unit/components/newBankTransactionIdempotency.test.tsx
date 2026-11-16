// Bank WP2 row 7: the Spend/Receive Money page sends one Idempotency-Key per request body, blocks a double-click while
// the post is pending, reuses the key for a retry of the same body, and starts a new key for the next transaction.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('next/router', () => ({ useRouter: () => ({ push: vi.fn(async () => true), query: {}, isReady: true }) }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('@/lib/apiFetch', async (original) => ({ ...await original<typeof import('@/lib/apiFetch')>(), apiFetch: vi.fn(), apiJson: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/fetchAllSuppliers', async (original) => ({ ...await original<typeof import('@/lib/fetchAllSuppliers')>(), fetchAllSuppliers: vi.fn(async () => ({ suppliers: [], truncated: false })) }));

import { apiFetch, apiJson } from '@/lib/apiFetch';
import NewBankTransactionPage from '../../../pages/accounting/bank-transactions/new';

const ok = (data: unknown, status = 200) => new Response(JSON.stringify({ success: true, data }), { status });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const posts = () => vi.mocked(apiFetch).mock.calls.filter(([u]) => u === '/api/accounting/bank-transactions-manual');
const keyOf = (call: unknown[]) => new Headers((call[1] as RequestInit).headers).get('Idempotency-Key');

let reply: () => Promise<Response>;
beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
  vi.mocked(apiFetch).mockImplementation(async (url: unknown) => {
    if (String(url).includes('chart-of-accounts')) return ok([{ id: 'gl1', accountCode: '6000', accountName: 'Fuel', accountSubtype: null }]);
    if (String(url).includes('bank-transactions-manual')) return reply();
    return ok([]);
  });
  vi.mocked(apiJson).mockReset();
  vi.mocked(apiJson).mockResolvedValue([{ id: 'b1', accountCode: '1000', accountName: 'Cheque' }]);
});

async function fillForm(amount: string) {
  fireEvent.change(await screen.findByLabelText(/Amount/, undefined, { timeout: 3000 }), { target: { value: amount } });
  if (!screen.queryByDisplayValue('6000 — Fuel')) {
    fireEvent.change(screen.getByLabelText(/GL Account/), { target: { value: 'Fuel' } });
    fireEvent.click(await screen.findByRole('button', { name: /6000\s*Fuel/ }));
  }
}
const submit = () => screen.getByRole('button', { name: /record transaction|recording/i });

describe('new bank transaction idempotency', () => {
  it('a double-click while the post is pending sends ONE request with a UUID key, and the button is disabled', async () => {
    let release: (r: Response) => void = () => {};
    reply = () => new Promise<Response>((resolve) => { release = resolve; });
    render(<NewBankTransactionPage />);
    await fillForm('50');
    fireEvent.click(submit());
    fireEvent.click(submit());
    await waitFor(() => expect((submit() as HTMLButtonElement).disabled).toBe(true));
    fireEvent.click(submit());
    expect(posts()).toHaveLength(1);
    expect(keyOf(posts()[0]!)).toMatch(UUID);
    release(ok({ journalEntryId: 'je1' }, 201));
    await waitFor(() => expect((submit() as HTMLButtonElement).disabled).toBe(false));
  });

  it('a failed post retried with the same body reuses the key; the next transaction gets a new one', async () => {
    let attempt = 0;
    reply = async () => {
      attempt += 1;
      return attempt === 1
        ? new Response(JSON.stringify({ success: false, error: { code: 'X', message: 'timed out' } }), { status: 503 })
        : ok({ journalEntryId: `je${attempt}` }, 201);
    };
    render(<NewBankTransactionPage />);
    await fillForm('50');
    fireEvent.click(submit());
    await waitFor(() => expect(posts()).toHaveLength(1));
    await waitFor(() => expect((submit() as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(submit());
    await waitFor(() => expect(posts()).toHaveLength(2));
    await waitFor(() => expect((submit() as HTMLButtonElement).disabled).toBe(false));
    expect(keyOf(posts()[1]!)).toBe(keyOf(posts()[0]!));

    fireEvent.click(submit()); // same body again, after a success: a NEW transaction
    await waitFor(() => expect(posts()).toHaveLength(3));
    expect(keyOf(posts()[2]!)).toMatch(UUID);
    expect(keyOf(posts()[2]!)).not.toBe(keyOf(posts()[1]!));
  });
});
