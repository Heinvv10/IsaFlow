// The bank-rules page must tell the user when its supplier picker was cut at the
// walk's cap, the same way the bank-transactions pages do (PUR-01 round 4).
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';

vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();
vi.mock('@/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/fetchAllSuppliers', async (original) => ({ ...await original<typeof import('@/lib/fetchAllSuppliers')>(), fetchAllSuppliers: vi.fn() }));

import { apiFetch } from '@/lib/apiFetch';
import { fetchAllSuppliers } from '@/lib/fetchAllSuppliers';
import BankRulesPage from '../../../pages/accounting/bank-reconciliation/rules';

beforeEach(() => {
  vi.mocked(fetchAllSuppliers).mockReset();
  vi.mocked(apiFetch).mockReset();
  vi.mocked(apiFetch).mockImplementation(async () => new Response(JSON.stringify({ success: true, data: [] }), { status: 200 }));
});

describe('bank rules page supplier list notice', () => {
  it('shows the cap notice when the supplier walk was truncated', async () => {
    vi.mocked(fetchAllSuppliers).mockResolvedValue({ suppliers: [{ id: 1, name: 'A' }], truncated: true });
    render(<BankRulesPage />);
    expect((await screen.findByRole('status', undefined, { timeout: 3000 })).textContent).toMatch(/first 10\s000 suppliers/);
  });
  it('shows no notice for a complete list', async () => {
    vi.mocked(fetchAllSuppliers).mockResolvedValue({ suppliers: [{ id: 1, name: 'A' }], truncated: false });
    render(<BankRulesPage />);
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.queryByText(/first 10\s000 suppliers/)).toBeNull();
  });
});
