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

  // Hein, step-2 decision 6: under manual-journal enforcement a matching transfer is held (202), not refused — the
  // page says so and links the draft journal and Approvals, and does not claim a completed transfer.
  it('on a held transfer (202 awaiting_approval) it shows Awaiting approval with links to the journal and Approvals', async () => {
    vi.mocked(apiFetch).mockImplementation(async (url: unknown) => {
      if (String(url).includes('chart-of-accounts')) return json(banks);
      return new Response(JSON.stringify({ success: true, message: 'Transfer of R2000.00 saved as a draft journal awaiting admin approval.',
        data: { status: 'awaiting_approval', journalId: 'je9', requestId: 'rq9', requiredRole: 'admin' } }), { status: 202 });
    });
    render(<BankTransfersPage />);
    await screen.findAllByRole('option', { name: '1000 — Current Account' });
    const [fromSelect, toSelect] = screen.getAllByRole('combobox');
    fireEvent.change(fromSelect!, { target: { value: FROM } });
    fireEvent.change(toSelect!, { target: { value: TO } });
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '2000' } });
    fireEvent.click(screen.getByRole('button', { name: /process transfer/i }));
    expect(await screen.findByText('Awaiting approval')).toBeTruthy();
    expect(screen.getByText(/saved as a draft journal awaiting admin approval/)).toBeTruthy();
    expect(screen.getByRole('link', { name: /view the journal/i }).getAttribute('href')).toBe('/accounting/journal-entries/je9');
    expect(screen.getByRole('link', { name: /approvals/i }).getAttribute('href')).toBe('/accounting/approvals');
    expect(screen.queryByText(/Transfer completed/)).toBeNull();
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

  // brk-nrfa round 5 F2: an edit made while the checked POST is pending would land under the 428 that answers the
  // earlier body, and "post it anyway" would confirm a transfer nobody was warned about. The fields are disabled.
  it('disables every field while a transfer is being checked, and frees them when the answer lands', async () => {
    let release: (r: Response) => void = () => {};
    vi.mocked(apiFetch).mockImplementation(async (url: unknown) => {
      if (String(url).includes('chart-of-accounts')) return json(banks);
      return new Promise<Response>((r) => { release = r; });
    });
    render(<BankTransfersPage />);
    await screen.findAllByRole('option', { name: '1000 — Current Account' });
    const [fromSelect, toSelect] = screen.getAllByRole('combobox');
    fireEvent.change(fromSelect!, { target: { value: FROM } });
    fireEvent.change(toSelect!, { target: { value: TO } });
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '500' } });
    fireEvent.click(screen.getByRole('button', { name: /process transfer/i }));
    const fields = () => [...screen.getAllByRole('combobox'), screen.getByRole('spinbutton'), screen.getByRole('textbox'),
      document.querySelector('input[type="date"]') as HTMLInputElement] as (HTMLInputElement | HTMLSelectElement)[];
    await waitFor(() => expect(fields().every((f) => f.disabled)).toBe(true));
    expect(fields()).toHaveLength(5);
    release(new Response(JSON.stringify({ success: false, error: { code: 'PRECONDITION_REQUIRED',
      message: 'A transfer like this is already in the ledger as JE-2026-00042' } }), { status: 428 }));
    expect(await screen.findByRole('button', { name: /post it anyway/i })).toBeTruthy();
    expect(fields().some((f) => f.disabled)).toBe(false);
  });
});
