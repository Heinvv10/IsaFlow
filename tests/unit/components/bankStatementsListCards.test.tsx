// Bank statement imports: both tables (the imports list and the paired-extensions panel) become labelled cards below lg instead of scrolling sideways at 640-700px; Upload PDF and Revoke are 44px.
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ imports: [] as unknown[], conns: [] as unknown[] }));
vi.mock('next/router', () => ({ useRouter: () => ({ push: vi.fn(), query: {}, pathname: '/' }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/apiFetch', async (orig) => ({
  ...(await orig<typeof import('@/lib/apiFetch')>()),
  apiFetch: vi.fn(async (url: string) => new Response(JSON.stringify({ success: true, data: String(url).includes('bank-feeds') ? { items: state.conns, count: state.conns.length } : state.imports }), { status: 200 })),
}));

import Page from '../../../pages/accounting/bank/statements/index';

const imp = (id: string) => ({ id, bankAccountId: `acc-${id}`, periodStart: '2026-10-01', periodEnd: '2026-10-31', rowCount: 40, importedCount: 38, duplicateCount: 2, status: 'committed', createdAt: '2026-11-02T08:00:00Z' });
const conn = (id: string) => ({ id, companyId: 'co', provider: 'extension', accountId: 'gl1', accountName: `Cheque ${id}`, accountNumberMasked: null, externalAccountId: '4051234567', status: 'active', lastSyncAt: null, lastSuccessAt: null, lastSyncStatus: 'success', lastSyncError: null, lastSync: null, config: { bankId: 'absa' }, createdAt: 'Sun Nov 01 2026 08:00:00 GMT+0200', updatedAt: 'x' });
beforeEach(() => { state.imports = [imp('1'), imp('2')]; state.conns = [conn('a')]; });
afterEach(cleanup);
const cls = (el: Element) => el.className.split(' ');
const MIN = 'max-lg:min-h-11';

describe('Bank statement imports on touch', () => {
  it('the imports table is labelled cards and drops its 700px minimum width', async () => {
    const { container } = render(<Page />);
    await screen.findByText('acc-1');
    const table = [...container.querySelectorAll('table')].find((t) => t.querySelector('th')?.textContent === 'Date uploaded')!;
    expect(cls(table)).toEqual(expect.arrayContaining(['table-cards', 'min-w-[700px]', 'max-lg:min-w-0']));
    expect([...table.querySelectorAll('thead th')].map((th) => th.textContent)).toEqual(['Date uploaded', 'Bank account', 'Period', 'Rows', 'Imported', 'Duplicates', 'Status']);
    const rows = [...table.querySelectorAll('tbody tr')];
    expect(rows).toHaveLength(2);
    for (const r of rows) expect([...r.querySelectorAll('td')].map((td) => td.getAttribute('data-label'))).toEqual(['Date uploaded', 'Bank account', 'Period', 'Rows', 'Imported', 'Duplicates', 'Status']);
  });

  it('Upload PDF is 44px', async () => {
    render(<Page />);
    await screen.findByText('acc-1');
    expect(cls(screen.getByRole('button', { name: /Upload PDF/ }))).toContain(MIN);
  });

  it('the paired-extensions table is labelled cards too (account is the heading, Revoke the footer) and Revoke is 44px', async () => {
    const { container } = render(<Page />);
    await screen.findByRole('button', { name: /Revoke Cheque a/ });
    const table = [...container.querySelectorAll('table')].find((t) => t.querySelector('th')?.textContent === 'Bank account' && t.querySelectorAll('th').length === 5)!;
    expect(cls(table)).toEqual(expect.arrayContaining(['table-cards', 'min-w-[640px]', 'max-lg:min-w-0']));
    const cells = [...table.querySelectorAll('tbody tr')[0]!.querySelectorAll('td')];
    expect(cells.map((td) => td.getAttribute('data-label'))).toEqual([null, 'Paired', 'Last import', 'Status', null]);
    expect(cls(screen.getByRole('button', { name: /Revoke Cheque a/ }))).toContain(MIN);
  });
});
