// Banking > Transfers: the account lists come from GET chart-of-accounts, which answers a plain camelCased array,
// filtered with isBankSubtype (the transfer route's own rule). The page read `data.accounts` and snake_case names, so
// both lists were always empty (2026-10-08).
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
// The whole chart: both bank spellings the route accepts are offered, other accounts are not.
const banks = [
  { id: FROM, accountCode: '1000', accountName: 'Current Account', accountSubtype: 'bank' },
  { id: TO, accountCode: '1010', accountName: 'Savings', accountSubtype: 'bank_account' },
  { id: 'v1', accountCode: '1140', accountName: 'VAT Input', accountSubtype: 'vat_input' },
  { id: 'x1', accountCode: '6000', accountName: 'Expenses', accountSubtype: null },
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
    expect(screen.queryByRole('option', { name: /VAT Input|Expenses/ })).toBeNull();

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

  // brk-nrfa round 3 M2: a possible duplicate is a 428 the person can confirm, not a dead end.
  it('on a 428 it offers to post anyway, and resends with confirmDuplicate', async () => {
    let posts = 0;
    vi.mocked(apiFetch).mockImplementation(async (url: unknown) => {
      if (String(url).includes('chart-of-accounts')) return json(banks);
      posts += 1;
      if (posts <= 2) {
        return new Response(JSON.stringify({ success: false, error: { code: 'PRECONDITION_REQUIRED',
          message: 'A transfer like this is already in the ledger as JE-2026-00042' } }), { status: 428 });
      }
      return json({ journalEntry: { id: 'je2' }, message: 'ok' });
    });
    render(<BankTransfersPage />);
    await screen.findAllByRole('option', { name: '1000 — Current Account' });
    const [fromSelect, toSelect] = screen.getAllByRole('combobox');
    fireEvent.change(fromSelect!, { target: { value: FROM } });
    fireEvent.change(toSelect!, { target: { value: TO } });
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '500' } });
    fireEvent.click(screen.getByRole('button', { name: /process transfer/i }));
    expect(await screen.findByText(/already in the ledger as JE-2026-00042/)).toBeTruthy();
    // An edit withdraws the offer: the confirmation covers the transfer that was checked (brk-nrfa round 4 LOW-2).
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '501' } });
    expect(screen.queryByRole('button', { name: /post it anyway/i })).toBeNull();
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '500' } });
    fireEvent.click(screen.getByRole('button', { name: /process transfer/i }));
    expect(await screen.findByRole('button', { name: /post it anyway/i })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /post it anyway/i }));
    expect(await screen.findByText(/Transfer completed/)).toBeTruthy();
    const bodies = vi.mocked(apiFetch).mock.calls.filter(([u]) => u === '/api/accounting/bank-transfers')
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)));
    expect(bodies[0].confirmDuplicate).toBeUndefined();
    expect(bodies[1].confirmDuplicate).toBeUndefined();
    expect(bodies[2].confirmDuplicate).toBe(true);
  });
});
