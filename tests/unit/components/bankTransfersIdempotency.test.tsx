// Bank WP2 row 7: the transfer form sends one Idempotency-Key per request body and cannot be submitted twice while a
// post is in flight. The mock holds the POST open so the double-click lands while it is pending.
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();

import { apiFetch } from '@/lib/apiFetch';
import BankTransfersPage from '../../../pages/accounting/bank-transfers/index';

const FROM = '10000000-0000-4000-8000-000000000001';
const TO = '10000000-0000-4000-8000-000000000002';
const banks = [
  { id: FROM, accountCode: '1000', accountName: 'Current Account', accountSubtype: 'bank' },
  { id: TO, accountCode: '1010', accountName: 'Savings', accountSubtype: 'bank' },
];
const ok = (data: unknown, status = 200) => new Response(JSON.stringify({ success: true, data }), { status });
afterEach(() => { vi.mocked(apiFetch).mockReset(); });

const posts = () => vi.mocked(apiFetch).mock.calls.filter(([u]) => u === '/api/accounting/bank-transfers');
const keyOf = (call: unknown[]) => new Headers((call[1] as RequestInit).headers).get('Idempotency-Key');

async function fillForm(amount: string) {
  await screen.findAllByRole('option', { name: '1000 — Current Account' });
  const [fromSelect, toSelect] = screen.getAllByRole('combobox');
  fireEvent.change(fromSelect!, { target: { value: FROM } });
  fireEvent.change(toSelect!, { target: { value: TO } });
  fireEvent.change(screen.getByRole('spinbutton'), { target: { value: amount } });
}

describe('BankTransfersPage idempotency', () => {
  it('a double-click while the post is pending sends ONE request, with a UUID key, and the button is disabled', async () => {
    let release: (r: Response) => void = () => {};
    vi.mocked(apiFetch).mockImplementation(async (url: unknown) => {
      if (String(url).includes('chart-of-accounts')) return ok(banks);
      return new Promise<Response>((resolve) => { release = resolve; });
    });
    render(<BankTransfersPage />);
    await fillForm('100');
    const button = screen.getByRole('button', { name: /process transfer/i });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(true));
    fireEvent.click(button);
    expect(posts()).toHaveLength(1);
    expect(keyOf(posts()[0]!)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    release(ok({ journalEntry: { id: 'je1' } }));
    expect(await screen.findByText(/Transfer completed/)).toBeTruthy();
  });

  it('a failed post retried with the same body reuses the key; after a success the next transfer gets a new one', async () => {
    let attempt = 0;
    vi.mocked(apiFetch).mockImplementation(async (url: unknown) => {
      if (String(url).includes('chart-of-accounts')) return ok(banks);
      attempt += 1;
      if (attempt === 1) return new Response(JSON.stringify({ success: false, error: { code: 'X', message: 'timed out' } }), { status: 503 });
      return ok({ journalEntry: { id: `je${attempt}` } });
    });
    render(<BankTransfersPage />);
    await fillForm('100');
    fireEvent.click(screen.getByRole('button', { name: /process transfer/i }));
    await screen.findByText(/timed out|Could not record/);
    fireEvent.click(screen.getByRole('button', { name: /process transfer/i }));
    await screen.findByText(/Transfer completed/);
    expect(keyOf(posts()[1]!)).toBe(keyOf(posts()[0]!));

    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '100' } });
    fireEvent.click(screen.getByRole('button', { name: /process transfer/i }));
    await waitFor(() => expect(posts()).toHaveLength(3));
    expect(keyOf(posts()[2]!)).not.toBe(keyOf(posts()[1]!));
  });

  it('an edit after a failed post is a different request and gets a new key', async () => {
    vi.mocked(apiFetch).mockImplementation(async (url: unknown) => {
      if (String(url).includes('chart-of-accounts')) return ok(banks);
      return new Response(JSON.stringify({ success: false, error: { code: 'X', message: 'timed out' } }), { status: 503 });
    });
    render(<BankTransfersPage />);
    await fillForm('100');
    fireEvent.click(screen.getByRole('button', { name: /process transfer/i }));
    await screen.findByText(/timed out|Could not record/);
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '120' } });
    fireEvent.click(screen.getByRole('button', { name: /process transfer/i }));
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(keyOf(posts()[1]!)).not.toBe(keyOf(posts()[0]!));
  });
});
