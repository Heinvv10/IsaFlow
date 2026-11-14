// Admin audit 2026-11-14, item 3.4 (code-4 F-18): the admin CSV migration tool
// pre-selected the first company in the list (0GP Golden Migration Sandbox in
// production), so an upload and Execute landed there unless the admin noticed,
// and Execute ran with no confirm. Now no company is chosen until the admin picks
// one, and Execute asks first, naming the company and the record count.
import { cleanup, configure, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

configure({ asyncUtilTimeout: 4000 });
vi.mock('@/components/admin/AdminLayout', () => ({ AdminLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();

import { apiFetch } from '@/lib/apiFetch';
import AdminMigrationsPage from '../../../pages/admin/tools/migrations';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const COMPANIES = [{ id: 'co-sandbox', name: '0GP Sandbox', trading_name: null }, { id: 'co-target', name: 'Target Ltd', trading_name: null }];
const RESULT = { accountsImported: 2, customersImported: 0, suppliersImported: 0, customersSkipped: 0, suppliersSkipped: 0,
  customersFailed: 0, suppliersFailed: 0, openingBalancesSet: 0, errors: [] };
let confirmSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.mocked(apiFetch).mockImplementation(async (url) => {
    const u = String(url);
    if (u.includes('/api/admin/companies')) return json({ success: true, data: { items: COMPANIES } });
    if (u.includes('migration-parse')) return json({ success: true, data: { parsed: [{ a: 1 }, { a: 2 }], count: 2 } });
    if (u.includes('migration-execute')) return json({ success: true, data: RESULT });
    return json({ success: true, data: {} });
  });
  confirmSpy = vi.fn(() => false);
  vi.stubGlobal('confirm', confirmSpy);
});
afterEach(() => { cleanup(); vi.mocked(apiFetch).mockReset(); });

const executes = () => vi.mocked(apiFetch).mock.calls.filter(([u]) => String(u).includes('migration-execute'));
const companySelect = () => screen.getAllByRole('combobox')[0] as HTMLSelectElement;
const file = () => new File(['code,name\n1000,Bank'], 'accounts.csv', { type: 'text/csv' });

describe('admin CSV migration: the target company', () => {
  it('starts with no company chosen, and nothing can be uploaded until one is', async () => {
    render(<AdminMigrationsPage />);
    await screen.findByRole('option', { name: 'Target Ltd' });
    expect(companySelect().value).toBe('');
    for (const b of screen.getAllByRole('button', { name: /chart of accounts|customers|suppliers/i })) {
      expect((b as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it('Execute confirms, naming the company and the count, and posts only when accepted', async () => {
    const { container } = render(<AdminMigrationsPage />);
    await screen.findByRole('option', { name: 'Target Ltd' });
    fireEvent.change(companySelect(), { target: { value: 'co-target' } });
    fireEvent.change(container.querySelectorAll('input[type="file"]')[0]!, { target: { files: [file()] } });
    fireEvent.click(await screen.findByRole('button', { name: /execute migration/i }));
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(String(confirmSpy.mock.calls[0]?.[0])).toMatch(/2 records.*Target Ltd/);
    await new Promise((r) => setTimeout(r, 30));
    expect(executes()).toEqual([]);

    confirmSpy.mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: /execute migration/i }));
    await screen.findByText(/migration complete/i);
    expect(executes()).toHaveLength(1);
    expect((executes()[0]![1]?.headers as Record<string, string>)['X-Company-Id']).toBe('co-target');
  });
});
