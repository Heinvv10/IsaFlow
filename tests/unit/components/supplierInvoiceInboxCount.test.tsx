// The Bills list loads the intercompany inbox count for its tab badge. An answer that belongs to an effect run that has since been
// cleaned up (a remount, as React Strict Mode does on every mount in development) must never be applied over the newer one.
import { StrictMode } from 'react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { ok } from '../helpers/d2R3a6';

const route = vi.hoisted(() => ({ query: {} as Record<string, string>, isReady: true, pathname: '/', push: vi.fn(), replace: vi.fn() }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/router', () => ({ useRouter: () => route }));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'owner', companyId: 'c1', activeCompany: { id: 'c1' }, companies: [], loading: false }) }));

import { apiFetch } from '@/lib/apiFetch';
import SupplierInvoicesPage from '../../../pages/accounting/supplier-invoices/index';

useApiJsonOverMock();
beforeEach(() => { vi.mocked(apiFetch).mockReset(); route.query = {}; });
afterEach(() => { cleanup(); });

/** The inbox-count calls, each held until the test releases it; everything else is an empty, valid answer. */
function holdInboxCount() {
  const held: Array<(count: number) => void> = [];
  vi.mocked(apiFetch).mockImplementation(async (url: unknown) => {
    const u = String(url);
    if (u.includes('inbox-count')) return new Promise<Response>((resolve) => { held.push((n) => resolve(ok({ enabled: true, openCount: n }))); });
    if (u.includes('status_counts')) return ok({ counts: {} });
    return ok({ invoices: [], total: 0 });
  });
  return held;
}

describe('the Intercompany count on the Bills list', () => {
  it('a stale answer from a cleaned-up effect run does not replace the newer one', async () => {
    const held = holdInboxCount();
    render(<StrictMode><SupplierInvoicesPage /></StrictMode>);
    await waitFor(() => expect(held.length).toBe(2)); // Strict Mode ran the effect twice: the first run was cleaned up
    await act(async () => { held[1]!(2); });
    await waitFor(() => expect(screen.getByTestId('intercompany-badge')).toHaveTextContent('2'));
    await act(async () => { held[0]!(5); }); // the first run's slow answer, arriving last
    expect(screen.getByTestId('intercompany-badge')).toHaveTextContent('2');
  });
});
