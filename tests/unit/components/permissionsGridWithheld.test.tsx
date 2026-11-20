/**
 * #1656 round 4: PermissionsGrid shows the "withhold Approve and Payroll" flag for a manager (and a stored legacy role), saves it with
 * PUT on its own route, and shows nothing for an owner or admin, who cannot be restricted.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { PermissionsGrid } from '../../../src/components/accounting/user-access/PermissionsGrid';

afterEach(() => cleanup());

function fetcherWith(approveWithheld: boolean) {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body as string | undefined });
    const data = (init?.method ?? 'GET') === 'GET' ? { permissions: [{ moduleKey: 'suppliers', moduleName: 'Suppliers & AP', canRead: true, canWrite: true, canDelete: false, canExport: true, canApprove: false, accountRangeFrom: null, accountRangeTo: null }], approveWithheld } : { ok: true };
    return new Response(JSON.stringify({ success: true, data }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  return { fetcher, calls };
}

describe('PermissionsGrid approveWithheld', () => {
  it.each(['manager', 'accountant', 'bookkeeper', 'viewer'])('shows the checkbox for a %s, reflecting the loaded flag, and saves a change with PUT', async (role) => {
    const { fetcher, calls } = fetcherWith(true);
    render(<PermissionsGrid userId="u-1" userRole={role} onFeedback={vi.fn()} fetcher={fetcher as never} saveFields={{ userId: 'u-1' }} />);
    const box = await screen.findByRole('checkbox') as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(JSON.parse(calls.find((c) => c.method === 'PUT')!.body!)).toEqual({ userId: 'u-1', approveWithheld: false });
  });

  it.each(['owner', 'admin'])('shows no checkbox for an %s (full access cannot be restricted)', async (role) => {
    const { fetcher } = fetcherWith(false);
    render(<PermissionsGrid userId="u-1" userRole={role} onFeedback={vi.fn()} fetcher={fetcher as never} />);
    await screen.findByText(/Full Access/);
    expect(screen.queryByRole('checkbox')).toBeNull();
  });
});
