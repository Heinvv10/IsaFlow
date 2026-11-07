/**
 * Budgets P5-3: the new-PO page's per-line CC1 / CC2 / BU pickers (`PoLineDimensions`, shared with the detail
 * editor). Closed by default and reading nothing; opened, they list the company's active CC1 / CC2 / BU and the
 * picks go to POST /api/accounting/purchase-orders as each item's cc1Id / cc2Id / buId (null when none), so a PO
 * created in the UI is not born dimensionless.
 * Mutation check: drop a picked id from the POST body, or load the lists while closed, and a test goes red.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { pickOption } from '../helpers/kitPick';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

const route = vi.hoisted(() => ({ query: {} as Record<string, string>, isReady: true, pathname: '/', push: vi.fn(async () => true), replace: vi.fn() }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/router', () => ({ useRouter: () => route }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/accounting/supplier-invoices/SupplierSelect', () => ({
  SupplierSelect: ({ onChange }: { onChange: (id: string, name: string) => void }) =>
    <button type="button" onClick={() => onChange('sup-1', 'Supplier')}>pick supplier</button>,
}));

import { apiFetch } from '@/lib/apiFetch';
import NewPoPage from '../../../pages/accounting/purchase-orders/new';

const ok = (data: unknown, status = 200) => new Response(JSON.stringify({ success: true, data }), { status });
const LISTS: Record<string, unknown> = {
  'cc_type=cc1': { items: [{ id: 'cc1-ft', code: 'FT', name: 'Fibertime' }] },
  'cc_type=cc2': { items: [{ id: 'cc2-p1', code: 'P1', name: 'Project one' }] },
  'business-units': { items: [{ id: 'bu-ops', code: 'OPS', name: 'Operations' }] },
};
const urls = () => vi.mocked(apiFetch).mock.calls.map(([u]) => String(u));
const postBody = () => {
  const call = vi.mocked(apiFetch).mock.calls.find(([u, i]) => String(u) === '/api/accounting/purchase-orders' && (i as RequestInit)?.method === 'POST');
  return call ? JSON.parse(String((call[1] as RequestInit).body)) : undefined;
};

beforeEach(() => {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url: unknown) => {
    const u = String(url);
    const list = Object.entries(LISTS).find(([k]) => u.includes(k));
    if (list) return ok(list[1]);
    if (u === '/api/accounting/purchase-orders') return ok({ id: 'po-new' }, 201);
    throw new Error(`unexpected ${u}`);
  });
  route.push.mockClear();
});
afterEach(cleanup);
useApiJsonOverMock();

function fill() {
  render(<NewPoPage />);
  fireEvent.click(screen.getByText('pick supplier'));
  fireEvent.change(screen.getByPlaceholderText('Item description'), { target: { value: 'Widgets' } });
}

describe('purchase-orders/new — line dimensions', () => {
  it('closed: nothing is read, and each line posts null dimensions', async () => {
    fill();
    fireEvent.submit(document.querySelector('form') as HTMLFormElement);
    await waitFor(() => expect(postBody()).toBeDefined());
    expect(urls().some((u) => u.includes('cost-centres') || u.includes('business-units'))).toBe(false);
    expect(postBody().items[0]).toMatchObject({ description: 'Widgets', cc1Id: null, cc2Id: null, buId: null });
  });

  it('opened: the active CC1 / CC2 / BU are offered and the picks are posted on the line', async () => {
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Dimensions' }));
    await pickOption('Line 1 CC1', 'FT Fibertime');
    await pickOption('Line 1 CC2 project', 'P1 Project one');
    await pickOption('Line 1 BU', 'OPS Operations');
    fireEvent.submit(document.querySelector('form') as HTMLFormElement);
    await waitFor(() => expect(postBody()).toBeDefined());
    expect(postBody().items[0]).toMatchObject({ cc1Id: 'cc1-ft', cc2Id: 'cc2-p1', buId: 'bu-ops' });
    await waitFor(() => expect(route.push).toHaveBeenCalledWith('/accounting/purchase-orders/po-new'));
  });
});
