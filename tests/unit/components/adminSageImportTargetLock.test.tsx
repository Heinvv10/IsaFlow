// Admin audit 2026-11-14, item 3.4 (code-4 F-17): on the Sage auto-import the
// target company could be changed between Pull and Commit, and "Commit
// everything" posted a whole ledger into whatever the dropdown then said, with no
// confirm. Now the target is locked once data is pulled (only "Start over"
// unlocks it, and that discards the pulled data), and Commit asks first, naming
// the company it writes into.
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

configure({ asyncUtilTimeout: 4000 });
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
vi.mock('@/components/admin/AdminLayout', () => ({ AdminLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/admin/SageCommitSummary', () => ({ SageCommitSummary: () => <p>COMMITTED</p> }));
vi.mock('@/hooks/useAdminPrefix', () => ({ useAdminHref: () => (p: string) => p }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();

import { apiFetch } from '@/lib/apiFetch';
import SageImportPage from '../../../pages/admin/tools/sage-import';

const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const PULLED = {
  company: { record: { name: 'Sage Alpha' }, total: 1 },
  accounts: { records: [{ code: '1000' }], total: 1 }, customers: { records: [], total: 0 }, suppliers: { records: [], total: 0 },
  arInvoices: { records: [], total: 0 }, apInvoices: { records: [], total: 0 },
};
const SUMMARY = Object.fromEntries(['accounts', 'customers', 'suppliers', 'arInvoices', 'apInvoices']
  .map((k) => [k, { created: 0, skipped: 0, failed: [] }]));
let confirmSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.mocked(apiFetch).mockImplementation(async (url) => {
    const u = String(url);
    if (u.startsWith('/api/admin/companies')) return ok({ items: [{ id: 'co-a', name: 'Alpha Ltd' }, { id: 'co-b', name: 'Bravo Ltd' }] });
    if (u === '/api/admin/migration/sage-pull-server') return ok({ pulled: PULLED });
    if (u === '/api/admin/migration/sage-commit') return ok(SUMMARY);
    return ok({});
  });
  confirmSpy = vi.fn(() => false);
  vi.stubGlobal('confirm', confirmSpy);
});
afterEach(() => { cleanup(); vi.mocked(apiFetch).mockReset(); });

const commits = () => vi.mocked(apiFetch).mock.calls.filter(([u]) => String(u) === '/api/admin/migration/sage-commit');
const companySelect = () => screen.getByDisplayValue(/alpha ltd|bravo ltd|select a company/i) as HTMLSelectElement;

async function pullInto(companyId: string) {
  render(<SageImportPage />);
  await screen.findByRole('option', { name: 'Alpha Ltd' });
  fireEvent.change(companySelect(), { target: { value: companyId } });
  fireEvent.change(screen.getByPlaceholderText(/ApplicationCookie value/i), { target: { value: 'sage-session-cookie-value-0123456789' } });
  fireEvent.click(screen.getByRole('button', { name: /pull from sage with pasted cookie/i }));
  await screen.findByRole('button', { name: /commit everything/i });
}

describe('Sage import: the target company is fixed at Pull', () => {
  it('locks the company picker once data is pulled', async () => {
    await pullInto('co-a');
    expect(companySelect().disabled).toBe(true);
    expect(companySelect().value).toBe('co-a');
  });

  it('commits only after a confirm that names the pulled-for company', async () => {
    await pullInto('co-a');
    fireEvent.click(screen.getByRole('button', { name: /commit everything/i }));
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(String(confirmSpy.mock.calls[0]?.[0])).toContain('Alpha Ltd');
    // By design (3.4, pinned in sage-commit-closed-period-waiver.int.test.ts): the confirm says so.
    expect(String(confirmSpy.mock.calls[0]?.[0])).toContain(
      'Historical documents post into their original dates, including closed periods; periods with a filed VAT return are refused.');
    await new Promise((r) => setTimeout(r, 30));
    expect(commits()).toEqual([]); // declined: nothing posted

    confirmSpy.mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: /commit names \+ coa only/i }));
    await screen.findByText('COMMITTED');
    expect(commits()).toHaveLength(1);
    expect(JSON.parse(String(commits()[0]![1]?.body)).companyId).toBe('co-a');
  });

  it('"Start over" discards the pulled data and unlocks the picker', async () => {
    await pullInto('co-a');
    fireEvent.click(screen.getByRole('button', { name: /start over/i }));
    await waitFor(() => expect(companySelect().disabled).toBe(false));
    expect(screen.queryByRole('button', { name: /commit everything/i })).toBeNull();
  });
});
