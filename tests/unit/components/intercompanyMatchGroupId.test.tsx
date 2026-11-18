// Match button must send groupId (the route returns 400 "groupId required" without it).
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

configure({ asyncUtilTimeout: 4000 });
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'owner' }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));

import { apiFetch } from '@/lib/apiFetch';
import IntercompanyPage from '../../../pages/accounting/group/intercompany';

useApiJsonOverMock();
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const GROUP = { id: 'g1', name: 'Grp', companies: [{ id: 'c1', name: 'Alpha Co' }, { id: 'c2', name: 'Beta Co' }] };
const tx = (id: string) => ({
  id, date: '2026-11-05', sourceCompanyId: 'c1', targetCompanyId: 'c2', sourceCompanyName: 'Alpha Co',
  targetCompanyName: 'Beta Co', type: 'sale', amount: 100, currency: 'ZAR', status: 'unmatched',
});
beforeEach(() => { vi.mocked(apiFetch).mockReset(); });
afterEach(() => { cleanup(); });

describe('IntercompanyPage match', () => {
  it('POSTs groupId with the two selected ids and shows the success message', async () => {
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      const u = String(url);
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        // mirror the route: no groupId -> 400
        return body.groupId ? ok({}) : new Response(JSON.stringify({ success: false, error: { code: 'BAD_REQUEST', message: 'groupId required' } }), { status: 400 });
      }
      if (u.includes('company-groups')) return ok({ items: [GROUP] });
      if (u.includes('action=reconciliation')) return ok(null);
      return ok({ items: [tx('t1'), tx('t2')] });
    });
    render(<IntercompanyPage />);
    await waitFor(() => expect(screen.getAllByRole('checkbox').length).toBe(2));
    screen.getAllByRole('checkbox').forEach((c) => fireEvent.click(c.closest('td')!));
    fireEvent.click(await screen.findByRole('button', { name: /Match Selected \(2\)/ }));
    expect(await screen.findByText('Transactions matched')).toBeTruthy();
    const post = vi.mocked(apiFetch).mock.calls.find(([, init]) => init?.method === 'POST')!;
    expect(JSON.parse(String(post[1]!.body))).toEqual({ action: 'match', groupId: 'g1', sourceId: 't1', targetId: 't2' });
  });

  const mountWithTxs = () => {
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      const u = String(url);
      if (init?.method === 'POST') return ok({});
      if (u.includes('company-groups')) return ok({ items: [GROUP] });
      if (u.includes('action=reconciliation')) return ok(null);
      return ok({ items: [tx('t1'), tx('t2')] });
    });
    render(<IntercompanyPage />);
  };

  it('clicking a row selects it exactly once', async () => {
    mountWithTxs();
    await waitFor(() => expect(screen.getAllByRole('checkbox').length).toBe(2));
    fireEvent.click(screen.getAllByRole('checkbox')[0]!.closest('tr')!);
    expect((screen.getAllByRole('checkbox')[0] as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText('Select 1 more transaction to match')).toBeTruthy();
  });

  it('clicking the checkbox itself selects it exactly once', async () => {
    mountWithTxs();
    await waitFor(() => expect(screen.getAllByRole('checkbox').length).toBe(2));
    fireEvent.click(screen.getAllByRole('checkbox')[0]!);
    expect((screen.getAllByRole('checkbox')[0] as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText('Select 1 more transaction to match')).toBeTruthy();
  });

  it('recording a transaction keeps the success message after the reload', async () => {
    mountWithTxs();
    await waitFor(() => expect(screen.getAllByRole('checkbox').length).toBe(2));
    fireEvent.click(screen.getByRole('button', { name: /Record Transaction/ }));
    const combos = await screen.findAllByRole('combobox');
    const dlgStart = combos.length - 3;
    fireEvent.change(combos[dlgStart]!, { target: { value: 'c1' } });
    fireEvent.change((await screen.findAllByRole('combobox'))[dlgStart + 1]!, { target: { value: 'c2' } });
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '50' } });
    fireEvent.click(screen.getByRole('button', { name: /^Record$/ }));
    expect(await screen.findByText('Transaction recorded')).toBeTruthy();
  });
});
