/**
 * WP7 UI: the query modal offers "save as default" and a free number only to an owner/admin (the server refuses anyone
 * else); an unconfirmed send shows as "Send not confirmed" and can still be resolved or cancelled; the client-queries
 * "Open" tab asks for open (sent + unconfirmed); the Cashbook export sends the params the route reads.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

const role = vi.hoisted(() => ({ value: 'owner' as string | null }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompanyRoleOrNull: () => role.value }));

import { apiFetch } from '@/lib/apiFetch';
import { BankTxQueryModal } from '@/components/accounting/BankTxQueryModal';
import { QueryRowActions, StatusBadge, type BankTxQueryRow } from '@/components/accounting/bank/QueryRow';
import { cashbookExportParams } from '@/components/accounting/cashbookExport';
import { canDirectBankQueries } from '@/lib/auth/writeRoles';
import type { BankTx } from '@/components/accounting/BankTxTable';

useApiJsonOverMock();
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const TX = { id: 'tx-1', transactionDate: '2026-06-01', description: 'WOOLWORTHS', amount: -115, status: 'imported' } as BankTx;

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
  vi.mocked(apiFetch).mockImplementation(async (u) => (String(u).includes('settings') ? ok({ clientQueryWhatsapp: '+27821234567', companyName: 'Acme' }) : ok([])));
});
afterEach(cleanup);

describe('canDirectBankQueries', () => {
  it('owner and admin only', () => {
    expect(['owner', 'admin', 'manager', 'accountant', 'viewer', null, undefined].map((r) => canDirectBankQueries(r)))
      .toEqual([true, true, false, false, false, false, false]);
  });
});

describe('BankTxQueryModal', () => {
  it.each(['owner', 'admin'])('an %s sees "save as default" and an editable number', async (r) => {
    role.value = r;
    render(<BankTxQueryModal tx={TX} onClose={() => undefined} />);
    expect(await screen.findByText(/Save as this client/)).toBeTruthy();
    expect((screen.getByPlaceholderText('+27 82 123 4567') as HTMLInputElement).readOnly).toBe(false);
    expect(screen.queryByTestId('query-number-locked')).toBeNull();
  });

  it.each(['manager', 'accountant', null])('a %s does NOT see "save as default", and the number is read-only with the reason', async (r) => {
    role.value = r;
    render(<BankTxQueryModal tx={TX} onClose={() => undefined} />);
    expect(await screen.findByTestId('query-number-locked')).toBeTruthy();
    expect(screen.queryByText(/Save as this client/)).toBeNull();
    expect((screen.getByPlaceholderText('+27 82 123 4567') as HTMLInputElement).readOnly).toBe(true);
  });

  const withData = (settings: unknown, queries: unknown) =>
    vi.mocked(apiFetch).mockImplementation(async (u) => (String(u).includes('settings') ? ok(settings) : ok(queries)));
  const HINT = /Ask an owner or admin to set the client's WhatsApp number in settings/;

  it('a manager with no saved number and no thread is told to ask an owner/admin (not just shown a blank locked box)', async () => {
    role.value = 'manager';
    withData({ clientQueryWhatsapp: null, companyName: 'Acme' }, []);
    render(<BankTxQueryModal tx={TX} onClose={() => undefined} />);
    expect(await screen.findByText(HINT)).toBeTruthy();
    expect(screen.queryByTestId('query-number-locked')).toBeNull();
  });

  it('a manager on a line that already has a thread follows up on THAT number, with no hint', async () => {
    role.value = 'manager';
    withData({ clientQueryWhatsapp: null, companyName: 'Acme' }, [{ id: 'q1', status: 'sent', sent_at: null, to_number: '+27829990000' }]);
    render(<BankTxQueryModal tx={TX} onClose={() => undefined} />);
    await screen.findByDisplayValue('+27829990000');
    expect(screen.queryByText(HINT)).toBeNull();
  });

  it('an owner with no saved number just types one: no hint', async () => {
    role.value = 'owner';
    withData({ clientQueryWhatsapp: null, companyName: 'Acme' }, []);
    render(<BankTxQueryModal tx={TX} onClose={() => undefined} />);
    await screen.findByText(/Save as this client/);
    expect(screen.queryByText(HINT)).toBeNull();
  });
});

describe('an unconfirmed query', () => {
  const row = (status: BankTxQueryRow['status']): BankTxQueryRow => ({
    id: 'q1', bank_transaction_id: 'tx-1', to_number: '+27821234567', message_body: 'hi', status, reply_text: null, sent_at: null,
    replied_at: null, resolved_at: null, transaction_date: null, tx_description: 'd', amount: -1, tx_status: null, bank_account_name: null, attachment_count: 0,
  });
  it('reads "Send not confirmed", never "Sent"', () => {
    render(<StatusBadge status="unconfirmed" />);
    expect(screen.getByText('Send not confirmed')).toBeTruthy();
    expect(screen.queryByText('Sent')).toBeNull();
  });
  it('can be resolved or cancelled (it is still open)', () => {
    render(<QueryRowActions row={row('unconfirmed')} acting={null} onViewSlips={() => undefined} onResolve={() => undefined} onCancel={() => undefined} />);
    expect(screen.getByText('Resolve')).toBeTruthy();
    expect(screen.getByText('Cancel')).toBeTruthy();
  });
  it('a resolved query offers neither', () => {
    render(<QueryRowActions row={row('resolved')} acting={null} onViewSlips={() => undefined} onResolve={() => undefined} onCancel={() => undefined} />);
    expect(screen.queryByText('Resolve')).toBeNull();
  });
});

describe('cashbookExportParams', () => {
  const accounts = [{ id: 'a1', accountCode: '1110' }, { id: 'a2', accountCode: '1120' }];
  it('sends account_code, period_start and period_end - the names the export route reads', () => {
    expect(cashbookExportParams(accounts, 'a2', '2026-01-01', '2026-01-31')).toEqual({ account_code: '1120', period_start: '2026-01-01', period_end: '2026-01-31' });
  });
  it('without a selected account it sends the dates only (the route defaults the account)', () => {
    expect(cashbookExportParams(accounts, '', '2026-01-01', '2026-01-31')).toEqual({ period_start: '2026-01-01', period_end: '2026-01-31' });
  });
});
