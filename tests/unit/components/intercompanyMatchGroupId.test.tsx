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
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const G1 = '11111111-1111-4111-8111-111111111111';
const G2 = '22222222-2222-4222-8222-222222222222';
const C1 = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';
const C2 = 'c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2';
const T1 = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
const T2 = 'a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2';
const COMPANIES = [{ id: C1, name: 'Alpha Co' }, { id: C2, name: 'Beta Co' }];
const GROUP = { id: G1, name: 'Grp', companies: COMPANIES };
const GROUP_B = { id: G2, name: 'Grp B', companies: COMPANIES };
/** Mirrors the route: a non-UUID id is a 400, a missing groupId is a 400. */
const badUuid = (body: Record<string, unknown>, fields: string[]) => {
  const bad = fields.find((f) => typeof body[f] !== 'string' || !UUID_RE.test(body[f] as string));
  return bad ? new Response(JSON.stringify({ success: false, error: { code: 'BAD_REQUEST', message: `${bad} must be a valid UUID` } }), { status: 400 }) : null;
};
const tx = (id: string) => ({
  id, date: '2026-11-05', sourceCompanyId: C1, targetCompanyId: C2, sourceCompanyName: 'Alpha Co',
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
        return badUuid(body, ['groupId', 'sourceId', 'targetId']) ?? ok({});
      }
      if (u.includes('company-groups')) return ok({ items: [GROUP] });
      if (u.includes('action=reconciliation')) return ok(null);
      return ok({ items: [tx(T1), tx(T2)] });
    });
    render(<IntercompanyPage />);
    await waitFor(() => expect(screen.getAllByRole('checkbox').length).toBe(2));
    screen.getAllByRole('checkbox').forEach((c) => fireEvent.click(c.closest('td')!));
    fireEvent.click(await screen.findByRole('button', { name: /Match Selected \(2\)/ }));
    expect(await screen.findByText('Transactions matched')).toBeTruthy();
    const post = vi.mocked(apiFetch).mock.calls.find(([, init]) => init?.method === 'POST')!;
    expect(JSON.parse(String(post[1]!.body))).toEqual({ action: 'match', groupId: G1, sourceId: T1, targetId: T2 });
  });

  const mountWithTxs = () => {
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      const u = String(url);
      if (init?.method === 'POST') return badUuid(JSON.parse(String(init.body)), ['groupId']) ?? ok({});
      if (u.includes('company-groups')) return ok({ items: [GROUP, GROUP_B] });
      if (u.includes('action=reconciliation')) return ok(null);
      return ok({ items: [tx(T1), tx(T2)] });
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
    fireEvent.change(await screen.findByLabelText('Source Company'), { target: { value: C1 } });
    fireEvent.change(await screen.findByLabelText('Target Company'), { target: { value: C2 } });
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '50' } });
    fireEvent.click(screen.getByRole('button', { name: /^Record$/ }));
    expect(await screen.findByText('Transaction recorded')).toBeTruthy();
  });

  it('switching group clears the match selection', async () => {
    mountWithTxs();
    await waitFor(() => expect(screen.getAllByRole('checkbox').length).toBe(2));
    screen.getAllByRole('checkbox').forEach((c) => fireEvent.click(c.closest('td')!));
    expect(screen.getByRole('button', { name: /Match Selected \(2\)/ })).toBeTruthy();
    fireEvent.change(screen.getByDisplayValue('Grp'), { target: { value: G2 } });
    await waitFor(() => expect(screen.queryByRole('button', { name: /Match Selected/ })).toBeNull());
    expect(screen.queryByText('Select 1 more transaction to match')).toBeNull();
    screen.getAllByRole('checkbox').forEach((c) => expect((c as HTMLInputElement).checked).toBe(false));
  });
});
