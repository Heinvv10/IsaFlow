// D2 round 11: a failed open-period lookup must not run the balance sheet "as at" a date nobody chose.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { empty500, ok, on, serve, writeCalls } from '../helpers/d2R3a6';

const router = vi.hoisted(() => ({ query: {}, isReady: true, push: () => undefined, replace: () => undefined, pathname: '/' }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/router', () => ({ useRouter: () => router }));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
vi.mock('next/head', () => ({ default: () => null }));
vi.mock('next/dynamic', () => ({ default: () => () => null }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'owner', companyId: 'c1' }) }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ isAuthenticated: true, loading: false, user: { id: 'u-1', role: 'admin' } }) }));

import { apiFetch } from '@/lib/apiFetch';
import BalanceSheetPage from '../../../pages/accounting/reports/balance-sheet';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
beforeEach(() => { vi.mocked(apiFetch).mockReset(); });
afterEach(() => { cleanup(); });

describe('balance sheet: the open period did not load', () => {
  it('says so, leaves the date empty and does not run the report; picking a date runs it', async () => {
    serve(on('GET', 'fiscal-periods', empty500), on('GET', 'reports-balance-sheet', () => ok({ assets: [], liabilities: [], equity: [] })));
    render(<BalanceSheetPage />);
    expect(await screen.findByText(/Could not load the open period - try again/)).toBeDefined();
    const date = document.querySelector('input[type="date"]') as HTMLInputElement;
    expect(date.value).toBe('');
    expect(writeCalls('GET', 'reports-balance-sheet')).toBe(0);
    fireEvent.change(date, { target: { value: '2024-02-29' } });
    await waitFor(() => expect(writeCalls('GET', 'reports-balance-sheet')).toBeGreaterThan(0));
    expect(screen.queryByText(/Could not load the open period/)).toBeNull();
  });
});
