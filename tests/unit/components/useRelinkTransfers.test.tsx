// The bank page re-links transfer counterparts when a bank is selected. That route WRITES, so a viewer's
// page load must not call it (no 403 in the console) and must show no failure notice; a writer's still does.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const company = vi.hoisted(() => ({ role: null as string | null }));
vi.mock('@/lib/apiFetch', () => ({ apiFetch: vi.fn() }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: company.role }) }));

import { apiFetch } from '@/lib/apiFetch';
import { useRelinkTransfers } from '@/components/accounting/bank-transactions/useRelinkTransfers';

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

describe('useRelinkTransfers', () => {
  beforeEach(() => { vi.mocked(apiFetch).mockReset(); company.role = null; });

  it('does not call the write route for a viewer', async () => {
    company.role = 'viewer';
    const { result } = renderHook(() => useRelinkTransfers('bank-1'));
    await new Promise((r) => setTimeout(r, 20));
    expect(apiFetch).not.toHaveBeenCalled();
    expect(result.current).toBe(false);
  });

  it('does not call it while the role is still unknown', async () => {
    renderHook(() => useRelinkTransfers('bank-1'));
    await new Promise((r) => setTimeout(r, 20));
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('calls it once for a manager, with the selected bank', async () => {
    company.role = 'manager';
    vi.mocked(apiFetch).mockResolvedValue(reply(200, { success: true, data: { linked: 0, failed: false } }));
    renderHook(() => useRelinkTransfers('bank-1'));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    const [url, init] = vi.mocked(apiFetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/accounting/bank-relink-transfers');
    expect(JSON.parse(String(init.body))).toEqual({ bankAccountId: 'bank-1' });
  });

  it('reports a failed pass to a writer, and a 403 shows nothing', async () => {
    company.role = 'admin';
    vi.mocked(apiFetch).mockResolvedValueOnce(reply(200, { success: true, data: { linked: 0, failed: true } }));
    const failed = renderHook(() => useRelinkTransfers('bank-1'));
    await waitFor(() => expect(failed.result.current).toBe(true));

    vi.mocked(apiFetch).mockResolvedValueOnce(reply(403, { success: false, error: { code: 'FORBIDDEN', message: 'no' } }));
    const refused = renderHook(() => useRelinkTransfers('bank-2'));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
    expect(refused.result.current).toBe(false);
  });

  it('clears a stale failure notice when the user moves to a company where they are a viewer', async () => {
    company.role = 'admin';
    vi.mocked(apiFetch).mockResolvedValue(reply(200, { success: true, data: { linked: 0, failed: true } }));
    const { result, rerender } = renderHook(() => useRelinkTransfers('bank-1'));
    await waitFor(() => expect(result.current).toBe(true));
    company.role = 'viewer';
    rerender();
    await waitFor(() => expect(result.current).toBe(false));
  });
});
