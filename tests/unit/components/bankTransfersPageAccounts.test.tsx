// Banking > Transfers: the account lists come from GET chart-of-accounts?subtype=bank, which answers a plain
// camelCased array. The page read `data.accounts` and snake_case names, so both lists were always empty (2026-10-08).
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();

import { apiFetch } from '@/lib/apiFetch';
import BankTransfersPage from '../../../pages/accounting/bank-transfers/index';

const json = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
afterEach(() => { vi.mocked(apiFetch).mockReset(); });

const FROM = '10000000-0000-4000-8000-000000000001';
const TO = '10000000-0000-4000-8000-000000000002';
const banks = [
  { id: FROM, accountCode: '1000', accountName: 'Current Account', accountSubtype: 'bank' },
  { id: TO, accountCode: '1010', accountName: 'Savings', accountSubtype: 'bank' },
];

describe('BankTransfersPage', () => {
  it('lists the bank accounts in both selects and posts the chosen ids', async () => {
    vi.mocked(apiFetch).mockImplementation(async (url: unknown) => {
      if (String(url).includes('chart-of-accounts')) return json(banks);
      return json({ journalEntry: { id: 'je1' }, message: 'ok' });
    });
    render(<BankTransfersPage />);
    expect(await screen.findAllByRole('option', { name: '1000 — Current Account' })).toHaveLength(2);
    expect(screen.getAllByRole('option', { name: '1010 — Savings' })).toHaveLength(2);

    const [fromSelect, toSelect] = screen.getAllByRole('combobox');
    fireEvent.change(fromSelect!, { target: { value: FROM } });
    fireEvent.change(toSelect!, { target: { value: TO } });
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '125.50' } });
    fireEvent.click(screen.getByRole('button', { name: /transfer/i }));

    await waitFor(() => expect(vi.mocked(apiFetch)).toHaveBeenCalledWith('/api/accounting/bank-transfers', expect.anything()));
    const call = vi.mocked(apiFetch).mock.calls.find(([u]) => u === '/api/accounting/bank-transfers')!;
    expect(JSON.parse(String((call[1] as RequestInit).body))).toMatchObject({ fromAccountId: FROM, toAccountId: TO, amount: 125.5 });
    expect(await screen.findByText(/Transfer completed/)).toBeTruthy();
  });
});
