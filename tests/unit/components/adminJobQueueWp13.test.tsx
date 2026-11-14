// Admin Job Queue (WP13, admin audit 2026-11-14):
//  - 4.17 a reload (the 10 s poll, or Refresh: the same load) keeps the jobs the admin ticked;
//  - 3.7  Delete Old Jobs asks first: nothing is deleted until the admin confirms.
import { cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

configure({ asyncUtilTimeout: 4000 });
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/components/admin/AdminLayout', () => ({ AdminLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));

import { apiFetch } from '@/lib/apiFetch';
import JobQueuePage from '../../../pages/admin/job-queue';

useApiJsonOverMock();
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const job = (id: string) => ({ id, company_id: null, job_type: 'report', payload: {}, status: 'failed', priority: 0, attempts: 1,
  max_attempts: 3, scheduled_at: '2026-11-01T00:00:00Z', started_at: null, completed_at: null, error_message: 'x', result: null,
  created_at: '2026-11-01T00:00:00Z' });

beforeEach(() => {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url) => {
    if (String(url).startsWith('/api/admin/job-queue/bulk-action')) return ok({ processed: 3, errors: [] });
    return ok({ jobs: [job('j-1'), job('j-2')], total: 2 });
  });
});
afterEach(() => { cleanup(); });
const gets = () => vi.mocked(apiFetch).mock.calls.filter(([u, i]) => String(u).startsWith('/api/admin/job-queue?') && !i?.method).length;

describe('job queue', () => {
  it('a reload keeps the ticked jobs', async () => {
    render(<JobQueuePage />);
    fireEvent.click(await screen.findByLabelText('Select job j-1'));
    expect(await screen.findByText('1 job selected')).toBeTruthy();
    const before = gets();
    fireEvent.click(screen.getByRole('button', { name: /refresh/i }));
    await waitFor(() => expect(gets()).toBeGreaterThan(before));
    await waitFor(() => expect(screen.getByRole('button', { name: /refresh/i }).hasAttribute('disabled')).toBe(false));
    expect(screen.getByText('1 job selected')).toBeTruthy();
    expect(screen.getByLabelText('Select job j-1').getAttribute('aria-pressed')).toBe('true');
  });

  it('Delete Old Jobs deletes only after a confirm', async () => {
    render(<JobQueuePage />);
    fireEvent.click(await screen.findByRole('button', { name: /delete old jobs \(30d\)/i }));
    const dialog = await screen.findByRole('dialog');
    const deletes = () => vi.mocked(apiFetch).mock.calls.filter(([u, i]) => String(u) === '/api/admin/job-queue/bulk-action' && i?.method === 'POST');
    expect(deletes()).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: /delete old jobs/i }));
    await waitFor(() => expect(deletes()).toHaveLength(1));
    expect(JSON.parse(String(deletes()[0]![1]?.body))).toEqual({ action: 'delete_old', olderThanDays: 30 });
  });
});
