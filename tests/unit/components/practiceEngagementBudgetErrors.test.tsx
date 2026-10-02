// Engagement Budget error paths in the UI. The API answers a refusal as
// { success: false, error: { code, message } }: the time entry page and the
// Fill Range modal must show that message (they used to throw `e.error`, an
// object, and showed "[object Object]"). The report must not let a slower,
// older response overwrite the rows of the client chosen since, and the
// picker's own load error uses the light/dark red pair.
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

vi.mock('next/link', () => ({ default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());

import { apiFetch } from '@/lib/apiFetch';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import TimeEntryPage from '../../../pages/accounting/practice/time-entry/index';
import EngagementBudgetsPage from '../../../pages/accounting/practice/reports/engagement-budgets';
import { BulkRangeModal } from '@/components/practice/BulkRangeModal';
import { JobBudgetPicker } from '@/components/practice/JobBudgetPicker';

useApiJsonOverMock();
afterEach(() => { vi.mocked(apiFetch).mockReset(); });

const ok = (data: unknown, status = 200) => new Response(JSON.stringify({ success: true, data }), { status });
const refused = (message: string) =>
  new Response(JSON.stringify({ success: false, error: { code: 'BAD_REQUEST', message } }), { status: 400 });
const method = (init: unknown) => (init as RequestInit | undefined)?.method ?? 'GET';
const MSG = 'Job 1111 is complete: time can no longer be captured against it';

/** The reference data every practice form reads, by URL. */
function referenceData(url: string): Response | null {
  if (url.includes('/clients')) return ok({ clients: [{ id: 'c1', legalName: 'Acme' }] });
  if (url.includes('/job-categories')) return ok([{ id: 'cat1', name: 'Bookkeeping' }]);
  if (url.includes('/work-items')) return ok([{ id: 'wi1', name: 'Bank recs' }]);
  if (url.includes('/entry-templates')) return ok({ templates: [{ id: 't1', name: 'Monthly', practiceClientId: 'c1' }] });
  if (url.includes('/rate-resolve')) return ok({ rate: 1000 });
  if (url.includes('engagement-budgets')) return ok([]);
  return null;
}

describe('time entry page: a refused save shows the server message', () => {
  it('shows the 400 message, not "[object Object]"', async () => {
    vi.mocked(apiFetch).mockImplementation(async (url: unknown, init?: unknown) => {
      if (method(init) === 'POST') return refused(MSG);
      if (String(url).includes('/time-entries?')) return ok({ entries: [], total: 0 });
      return referenceData(String(url)) ?? ok([]);
    });
    const { container } = render(<TimeEntryPage />);
    const byOption = (text: string) =>
      [...container.querySelectorAll('select')].find((s) => [...s.options].some((o) => o.textContent === text))!;
    await screen.findByRole('option', { name: 'Acme' });
    fireEvent.change(byOption('Acme'), { target: { value: 'c1' } });
    fireEvent.change(byOption('Bookkeeping'), { target: { value: 'cat1' } });
    await screen.findByRole('option', { name: 'Bank recs' });
    fireEvent.change(byOption('Bank recs'), { target: { value: 'wi1' } });
    fireEvent.change(container.querySelector('input[placeholder="0.00"]')!, { target: { value: '1' } });
    fireEvent.change(container.querySelector('input[placeholder="Describe the work done…"]')!, { target: { value: 'Work' } });
    fireEvent.submit(container.querySelector('form')!);
    expect(await screen.findByText(MSG)).toBeTruthy();
    expect(screen.queryByText(/object Object/)).toBeNull();
  });
});

describe('Fill Range modal: a refused fill shows the server message', () => {
  it('shows the 400 message, not "[object Object]"', async () => {
    vi.mocked(apiFetch).mockImplementation(async (url: unknown, init?: unknown) =>
      method(init) === 'POST' ? refused(MSG) : (referenceData(String(url)) ?? ok([])));
    const onDone = vi.fn();
    render(<BulkRangeModal onClose={vi.fn()} onDone={onDone} />);
    await screen.findByRole('option', { name: 'Monthly' });
    fireEvent.click(screen.getByRole('button', { name: /Fill Range/ }));
    expect(await screen.findByText(MSG)).toBeTruthy();
    expect(screen.queryByText(/object Object/)).toBeNull();
    expect(onDone).not.toHaveBeenCalled();
  });
});

describe('Engagement Budgets report: a stale response does not win', () => {
  it('two client switches whose first response lands last show the newer client\'s rows', async () => {
    const pending: Record<string, (r: Response) => void> = {};
    const row = (title: string) => ({
      jobId: title, title, jobStatus: 'in_progress', practiceClientId: 'c', practiceClientName: 'X', budgetAmount: 1,
      consumedAmount: 0, balance: 1, budgetedHours: null, hoursUsed: 0, percentUsed: 0, state: 'ok',
    });
    vi.mocked(apiFetch).mockImplementation(async (url: unknown) => {
      const u = String(url);
      if (u.includes('/clients')) {
        return ok({ clients: [{ id: 'c1', legalName: 'One' }, { id: 'c2', legalName: 'Two' }] });
      }
      const client = /practiceClientId=(\w+)/.exec(u)?.[1];
      if (!client) return ok([row('All job')]);
      return new Promise<Response>((resolve) => { pending[client] = resolve; });
    });
    render(<EngagementBudgetsPage />);
    await screen.findByText('All job');
    await screen.findByRole('option', { name: 'Two' });
    const select = screen.getByLabelText('Client');
    fireEvent.change(select, { target: { value: 'c1' } });
    await waitFor(() => expect(pending.c1).toBeDefined());
    fireEvent.change(select, { target: { value: 'c2' } });
    await waitFor(() => expect(pending.c2).toBeDefined());
    pending.c2!(ok([row('Client two job')]));
    expect(await screen.findByText('Client two job')).toBeTruthy();
    pending.c1!(ok([row('Client one job')]));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText('Client one job')).toBeNull();
    expect(screen.getByText('Client two job')).toBeTruthy();
  });
});

describe('JobBudgetPicker load error', () => {
  it('uses the light/dark red pair', async () => {
    vi.mocked(apiFetch).mockResolvedValue(new Response('{}', { status: 500 }));
    render(<JobBudgetPicker practiceClientId="c1" jobId="" onChange={vi.fn()} refreshKey={0} selectClassName="" labelClassName="" />);
    const err = await screen.findByText('Could not load the jobs and their budgets - try again');
    expect(err.className).toContain('text-red-700 dark:text-red-400');
  });

  it('drops a chosen job that is no longer open once the list reloads', async () => {
    const row = (jobStatus: string) => ({ jobId: 'j1', title: 'AFS', jobStatus, practiceClientId: 'c1', practiceClientName: 'X',
      budgetAmount: 1, consumedAmount: 0, balance: 1, budgetedHours: null, hoursUsed: 0, percentUsed: 0, state: 'ok' });
    let status = 'in_progress';
    vi.mocked(apiFetch).mockImplementation(async () => ok([row(status)]));
    const onChange = vi.fn();
    const view = (key: number) => <JobBudgetPicker practiceClientId="c1" jobId="j1" onChange={onChange} refreshKey={key} selectClassName="" labelClassName="" />;
    const { rerender } = render(view(0));
    await screen.findByTestId('engagement-budget');
    expect(onChange).not.toHaveBeenCalled();
    status = 'complete';
    rerender(view(1));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(''));
  });
});

describe('Engagement Budgets report: a failed load', () => {
  it('clears the previous rows, shows the failure sentence, and the CSV button is off while loading', async () => {
    let fail = false;
    let release: (() => void) | null = null;
    vi.mocked(apiFetch).mockImplementation(async (url: unknown) => {
      if (String(url).includes('/clients')) return ok({ clients: [{ id: 'c1', legalName: 'One' }] });
      if (!fail) {
        return ok([{ jobId: 'j', title: 'Old row', jobStatus: 'in_progress', practiceClientId: 'c', practiceClientName: 'X',
          budgetAmount: 1, consumedAmount: 0, balance: 1, budgetedHours: null, hoursUsed: 0, percentUsed: 0, state: 'ok' }]);
      }
      await new Promise<void>((r) => { release = r; });
      return new Response('{}', { status: 500 });
    });
    render(<EngagementBudgetsPage />);
    await screen.findByText('Old row');
    await screen.findByRole('option', { name: 'One' });
    fail = true;
    fireEvent.change(screen.getByLabelText('Client'), { target: { value: 'c1' } });
    await waitFor(() => expect(release).not.toBeNull());
    expect((screen.getByRole('button', { name: /Download CSV/ }) as HTMLButtonElement).disabled).toBe(true);
    release!();
    expect(await screen.findByText('Could not load the jobs and their budgets - try again')).toBeTruthy();
    expect(screen.queryByText('Old row')).toBeNull();
  });
});
