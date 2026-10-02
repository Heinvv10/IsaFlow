/**
 * D2 census, group 1c: components that called `res.json()` on an unchecked apiFetch response.
 * Per site: a 400 with the real error envelope shows the server's message; a 500 with an EMPTY body shows a
 * plain sentence (never "JSON" / "Unexpected end"); a 200 envelope still renders its data. The real
 * apiFetch helpers run on top of the mocked apiFetch.
 */
import { useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/utils/toast', () => ({ notify: { warning: vi.fn(), success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('@/components/accounting/bank/BankAccountSelector', () => ({
  BankAccountSelector: ({ onChange }: { onChange: (id: string, o: unknown) => void }) => {
    useEffect(() => { onChange('acc1', { id: 'acc1', name: 'D2 Bank' }); }, []); // eslint-disable-line react-hooks/exhaustive-deps
    return <span />;
  },
}));

import { apiFetch } from '@/lib/apiFetch';
import { AccountReportingGroupModal } from '@/components/accounting/AccountReportingGroupModal';
import { BulkImportPanel } from '@/components/accounting/bank/BulkImportPanel';
import { ContactsTab } from '@/components/accounting/customers/ContactsTab';
import { NetcashTab } from '@/components/accounting/settings/NetcashTab';
import { BankSummaryWidget } from '@/components/dashboard/widgets/BankSummaryWidget';

useApiJsonOverMock();
afterEach(() => { cleanup(); });

const MSG = 'D2 server says no: this period is locked';
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const refuse = () => new Response(JSON.stringify({ success: false, error: { code: 'BAD_REQUEST', message: MSG } }), { status: 400 });
const emptyBody = () => new Response('', { status: 500 });

interface Site {
  name: string; ui: () => ReactElement; fails: (url: string) => boolean; plain: string; good: () => Response; shows: string;
  before?: () => Promise<void>;
}
const company = { netcashEnabled: true, netcashServiceKey: 'D2-KEY', netcashPayoutsKey: null } as never;
const csv = () => new File(['date,amount\n2026-01-01,10'], 'd2-statement.csv', { type: 'text/csv' });
async function pickFile(container: HTMLElement) {
  const input = container.querySelectorAll('input[type=file]')[1] as HTMLInputElement;
  fireEvent.change(input, { target: { files: [csv()] } });
  await screen.findByText('d2-statement.csv');
}
let previewCalls = 0;
const sites: Site[] = [
  { name: 'AccountReportingGroupModal: accounts', ui: () => <AccountReportingGroupModal group={null} onClose={vi.fn()} onSaved={vi.fn()} />,
    fails: u => u.includes('/chart-of-accounts'), plain: 'Could not load accounts - try again',
    good: () => ok({ items: [{ id: 'g1', code: '1000', name: 'D2 Cash Account', account_type: 'asset' }] }), shows: 'D2 Cash Account' },
  { name: 'ContactsTab: contacts', ui: () => <ContactsTab customerId="c1" />, fails: u => u.includes('/customer-contacts'),
    plain: 'Could not load contacts - try again', good: () => ok([{ id: 'k1', full_name: 'D2 Contact Person', is_primary: false }]), shows: 'D2 Contact Person' },
  { name: 'NetcashTab: test connection', ui: () => <NetcashTab company={company} onChange={vi.fn()} />, fails: u => u.includes('/netcash/test-connection'),
    plain: 'Could not test the connection - try again', good: () => ok({ valid: true }), shows: 'Connection successful',
    before: async () => { fireEvent.click(screen.getByRole('button', { name: 'Test Connection' })); } },
  { name: 'BankSummaryWidget: accounts', ui: () => <BankSummaryWidget />, fails: u => u.includes('/bank-accounts'),
    plain: 'Unable to load bank accounts - try again',
    good: () => ok([{ id: 'b1', account_name: 'D2 Cheque Account', account_code: '1100', bank_account_number: '123456', statement_balance: 1, gl_balance: 1, difference: 0 }]), shows: 'D2 Cheque Account' },
  { name: 'BulkImportPanel: preview', ui: () => <BulkImportPanel />, fails: u => u.includes('bulk-preview'),
    plain: 'Could not preview this file - try again', good: () => ok({ accountMatch: 'match', totalParsed: 42, rowHashes: [] }), shows: '42 parsed' },
];

async function open(s: Site, answer: () => Response) {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url) => (s.fails(String(url)) ? answer() : ok({})));
  const view = render(s.ui());
  if (s.name.startsWith('BulkImportPanel')) await pickFile(view.container);
  await s.before?.();
  return view;
}

describe.each(sites)('D2 census 1c: $name', (s) => {
  it('400: the server message from the error envelope is shown', async () => {
    await open(s, refuse);
    expect(await screen.findByText(MSG, { exact: false })).toBeTruthy();
  });

  it('500 with an empty body: a plain sentence is shown, not a JSON parse error', async () => {
    const { container } = await open(s, emptyBody);
    expect(await screen.findByText(s.plain, { exact: false })).toBeTruthy();
    expect(container.textContent).not.toMatch(/JSON|Unexpected end/i);
  });

  it('200: the data renders', async () => {
    await open(s, s.good);
    expect((await screen.findAllByText(s.shows, { exact: false })).length).toBeGreaterThan(0);
  });
});

// The Retry button re-runs the same preview call: first answer is a (valid) parse error, the second is under test.
describe.each([
  ['400: the server message from the error envelope is shown', refuse, MSG],
  ['500 with an empty body: a plain sentence is shown, not a JSON parse error', emptyBody, 'Could not preview this file - try again'],
  ['200: the retried preview renders its data', () => ok({ accountMatch: 'match', totalParsed: 42, rowHashes: [] }), '42 parsed'],
] as const)('D2 census 1c: BulkImportPanel retry, %s', (title, second, expected) => {
  it(title, async () => {
    previewCalls = 0;
    vi.mocked(apiFetch).mockReset().mockImplementation(async (url) => {
      if (!String(url).includes('bulk-preview')) return ok({});
      return previewCalls++ === 0 ? ok({ accountMatch: 'parse_error', rowHashes: [] }) : second();
    });
    const { container } = render(<BulkImportPanel />);
    await pickFile(container);
    fireEvent.click(await screen.findByRole('button', { name: 'Retry parse' }));
    expect(await screen.findByText(expected, { exact: false })).toBeTruthy();
    if (expected.startsWith('Could not')) expect(container.textContent).not.toMatch(/JSON|Unexpected end/i);
  });
});
