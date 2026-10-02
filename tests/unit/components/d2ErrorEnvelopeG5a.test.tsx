/**
 * D2 round: the API error envelope is `{ success:false, error:{ code, message } }`. These components read
 * `json.message` (always undefined), so the user saw the generic fallback. Each test answers with the REAL
 * envelope (4xx/5xx) carrying a unique message and asserts that exact text reaches the screen.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockedApiFetchModule, useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/components/accounting/migration/AccountMappingTable', () => ({ AccountMappingTable: () => null }));

import { apiFetch } from '@/lib/apiFetch';
import { ExternalMigrationWizard } from '@/components/accounting/migration/ExternalMigrationWizard';
import { AccountReportingGroupModal } from '@/components/accounting/AccountReportingGroupModal';
import { BundleEditor } from '@/components/accounting/items/BundleEditor';
import { MergeCustomersModal } from '@/components/accounting/customers/MergeCustomersModal';
import { BankTxQueryModal } from '@/components/accounting/BankTxQueryModal';
import type { BankTx } from '@/components/accounting/BankTxTable';

void mockedApiFetchModule;
useApiJsonOverMock();

const reply = (status: number, message: string) =>
  new Response(JSON.stringify({ success: false, error: { code: 'X', message } }), { status });
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });

afterEach(() => { cleanup(); vi.mocked(apiFetch).mockReset(); });

describe('ExternalMigrationWizard parse and verify', () => {
  const PARSE = 'D2 server says no: parse rejected the header row 4417';
  const VERIFY = 'D2 server says no: verify needs a closed period 8802';
  const upload = (container: HTMLElement) =>
    fireEvent.change(container.querySelectorAll('input[type="file"]')[0]!, {
      target: { files: [new File(['a,b'], 'accounts.csv', { type: 'text/csv' })] },
    });

  it('shows the server message when parsing the file fails', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => reply(422, PARSE));
    const { container } = render(<ExternalMigrationWizard source="xero" onDone={() => undefined} onBack={() => undefined} />);
    upload(container);
    expect(await screen.findByText(PARSE)).toBeTruthy();
  });

  it('shows the server message when Verify Balances fails', async () => {
    const parsed = [{ sourceCode: '1000', sourceName: 'Bank', sourceType: 'BANK', mappedType: 'asset', openingBalance: 5 }];
    vi.mocked(apiFetch).mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes('migration-parse')) return ok({ parsed });
      if (u.includes('migration-execute')) return ok({ accountsImported: 1, customersImported: 0, suppliersImported: 0, openingBalancesSet: 0, errors: [] });
      return reply(409, VERIFY);
    });
    const { container } = render(<ExternalMigrationWizard source="xero" onDone={() => undefined} onBack={() => undefined} />);
    upload(container);
    await screen.findByText(/1 records parsed/);
    fireEvent.click(screen.getByRole('button', { name: /next: map accounts/i }));
    fireEvent.click(screen.getByRole('button', { name: /next: review/i }));
    fireEvent.click(screen.getByRole('button', { name: /import now/i }));
    fireEvent.click(await screen.findByRole('button', { name: /verify balances/i }));
    expect(await screen.findByText(VERIFY)).toBeTruthy();
  });
});

describe('AccountReportingGroupModal save', () => {
  const group = { id: 'g1', name: 'Current Assets', report_type: 'balance_sheet' as const, display_order: 1, members: [] };
  const run = (isNew: boolean, failOn: 'create' | 'update' | 'members', message: string, status = 400) => {
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      const u = String(url);
      const method = (init as RequestInit | undefined)?.method;
      if (u.includes('chart-of-accounts')) return ok({ items: [] });
      if (u.includes('/members')) return failOn === 'members' ? reply(status, message) : ok({});
      if (method === 'POST') return failOn === 'create' ? reply(status, message) : ok({ id: 'g9' });
      if (method === 'PUT' || method === 'PATCH') return failOn === 'update' ? reply(status, message) : ok({});
      return ok({});
    });
    render(<AccountReportingGroupModal group={isNew ? null : group} onClose={() => undefined} onSaved={() => undefined} />);
    if (isNew) fireEvent.change(screen.getByPlaceholderText('e.g. Current Assets'), { target: { value: 'New group' } });
    fireEvent.click(screen.getByRole('button', { name: isNew ? /create group/i : /save changes/i }));
  };

  it('shows the server message when creating the group fails', async () => {
    const m = 'D2 server says no: group name already used 5521';
    run(true, 'create', m);
    expect(await screen.findByText(m)).toBeTruthy();
  });

  it('shows the server message when updating the group fails', async () => {
    const m = 'D2 server says no: group is locked by a report run 5522';
    run(false, 'update', m, 409);
    expect(await screen.findByText(m)).toBeTruthy();
  });

  it('shows the server message when saving the members fails', async () => {
    const m = 'D2 server says no: account 1010 is a header 5523';
    run(false, 'members', m, 500);
    expect(await screen.findByText(m)).toBeTruthy();
  });
});

describe('BundleEditor save', () => {
  it('shows the server message when saving the bundle fails', async () => {
    const m = 'D2 server says no: a bundle cannot contain itself 6631';
    vi.mocked(apiFetch).mockImplementation(async (_url, init) =>
      (init as RequestInit | undefined)?.method === 'POST' ? reply(400, m) : ok([]));
    render(<BundleEditor itemId="item-1" />);
    fireEvent.click(await screen.findByRole('button', { name: /save bundle/i }));
    expect(await screen.findByText(m)).toBeTruthy();
  });
});

describe('MergeCustomersModal merge', () => {
  it('shows the server message when the merge is refused', async () => {
    const m = 'D2 server says no: customer B has an open statement run 7741';
    vi.mocked(apiFetch).mockImplementation(async () => reply(409, m));
    const a = { id: 'a', name: 'Acme', email: null, vat: null, invoiceCount: 1 };
    const b = { id: 'b', name: 'Acme Ltd', email: null, vat: null, invoiceCount: 2 };
    render(<MergeCustomersModal candidateA={a} candidateB={b} onClose={() => undefined} onMerged={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: /confirm merge/i }));
    expect(await screen.findByText(m)).toBeTruthy();
  });
});

describe('BankTxQueryModal send', () => {
  it('shows the server message when the WhatsApp query is refused', async () => {
    const m = 'D2 server says no: WhatsApp number is not opted in 9913';
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      if ((init as RequestInit | undefined)?.method === 'POST') return reply(422, m);
      if (String(url).includes('/settings')) return ok({ clientQueryWhatsapp: '+27821234567', companyName: 'Acme' });
      return ok([]);
    });
    const tx = { id: 'tx-1', transactionDate: '2026-09-01', description: 'Deposit', amount: 100, status: 'pending' } as BankTx;
    render(<BankTxQueryModal tx={tx} onClose={() => undefined} />);
    const send = await screen.findByRole('button', { name: /^send$/i });
    await vi.waitFor(() => expect((send as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(send);
    expect(await screen.findByText(m)).toBeTruthy();
  });
});
