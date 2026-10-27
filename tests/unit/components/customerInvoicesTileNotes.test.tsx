/**
 * D2: the Outstanding tile says when part of its figure sits on soft-deleted invoices whose
 * journal was never reversed (no list row can show them), and stays plain otherwise.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

const router = vi.hoisted(() => ({ query: {} as Record<string, string>, isReady: true, pathname: '/', replace: vi.fn(), push: vi.fn(async () => true) }));

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/router', () => ({ useRouter: () => router }));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
vi.mock('next/head', () => ({ default: () => null }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companies: [], activeCompany: { id: 'c1' }, switchCompany: vi.fn() }) }));
vi.mock('@/components/shared/ExportCSVButton', () => ({ ExportCSVButton: () => null }));

import { apiFetch } from '@/lib/apiFetch';
import CustomerInvoicesPage from '../../../pages/accounting/customer-invoices/index';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
beforeEach(() => { vi.mocked(apiFetch).mockReset(); router.query = {}; });
afterEach(() => { cleanup(); });

const serve = (arSummary: Record<string, number>) => vi.mocked(apiFetch).mockResolvedValue(
  new Response(JSON.stringify({ success: true, data: { invoices: [], total: 0, arSummary } }), { status: 200 }),
);

describe('Outstanding tile note', () => {
  it('names the balance on deleted invoices with unreversed journals', async () => {
    serve({ outstanding: 5000, overdueCount: 1, overdueAmount: 900, onDeletedAmount: 1700 });
    render(<CustomerInvoicesPage />);
    expect(await screen.findByText(/Includes R\s*1\s*700 on deleted invoices with unreversed journals/)).toBeTruthy();
  });

  it('stays plain when there is none', async () => {
    serve({ outstanding: 5000, overdueCount: 1, overdueAmount: 900, onDeletedAmount: 0 });
    render(<CustomerInvoicesPage />);
    expect(await screen.findByText('Open balance, company-wide')).toBeTruthy();
    expect(screen.queryByText(/unreversed/)).toBeNull();
  });
});
