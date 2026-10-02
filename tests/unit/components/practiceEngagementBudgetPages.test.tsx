// Engagement Budget on the pages: the job detail panel (No budget / amber / red,
// light and dark colour pairs), the report (client name, signed balance, client
// filter) and the budget field on job create/edit, which must send budgetAmount
// and show a refusal's own message.
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { JobBudgetRow } from '@/components/practice/practiceApi';

const query: Record<string, string> = { id: 'job1' };
vi.mock('next/link', () => ({ default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ isReady: true, query, push: vi.fn() }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());

import { apiFetch } from '@/lib/apiFetch';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { JobBudgetPanel } from '@/components/practice/JobBudgetPanel';
import EngagementBudgetsPage from '../../../pages/accounting/practice/reports/engagement-budgets';
import NewPracticeJobPage from '../../../pages/accounting/practice/jobs/new';
import JobDetailPage from '../../../pages/accounting/practice/jobs/[id]';

useApiJsonOverMock();
afterEach(() => { vi.mocked(apiFetch).mockReset(); });

const ok = (data: unknown, status = 200) => new Response(JSON.stringify({ success: true, data }), { status });
const refused = (message: string) =>
  new Response(JSON.stringify({ success: false, error: { code: 'BAD_REQUEST', message } }), { status: 400 });
const row = (over: Partial<JobBudgetRow>): JobBudgetRow => ({
  jobId: 'job1', title: 'AFS 2026', jobStatus: 'in_progress', practiceClientId: 'c1', practiceClientName: 'Acme Trading',
  budgetAmount: 1000, consumedAmount: 500, balance: 500, budgetedHours: 10, hoursUsed: 5, percentUsed: 50, state: 'ok', ...over,
});
const urlOf = (u: unknown) => String(u);
const bodyOf = (call: unknown[]) => JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown>;

describe('JobBudgetPanel', () => {
  const show = async (r: JobBudgetRow) => {
    vi.mocked(apiFetch).mockResolvedValue(ok([r]));
    render(<JobBudgetPanel jobId="job1" refreshKey="t1" />);
    return screen.findByTestId('engagement-budget');
  };

  it('shows "No budget" for a job without one, in the readable slate pair', async () => {
    const box = await show(row({ budgetAmount: null, balance: null, percentUsed: null, state: 'none' }));
    const cells = within(box).getAllByText('No budget');
    expect(cells).toHaveLength(2);
    for (const c of cells) expect(c.className).toContain('text-slate-600');
    expect(urlOf(vi.mocked(apiFetch).mock.calls[0]![0])).toContain('engagement-budgets?jobId=job1');
  });

  it('is amber from 80% used', async () => {
    const box = await show(row({ consumedAmount: 850, balance: 150, percentUsed: 85, state: 'warning' }));
    expect(box.getAttribute('data-state')).toBe('warning');
    expect(within(box).getByText(/150\.00/).className).toContain('text-amber-800 dark:text-amber-400');
  });

  it('is red over budget, with the sign before the rand', async () => {
    const box = await show(row({ consumedAmount: 1900, balance: -900, percentUsed: 190, state: 'over' }));
    const balance = within(box).getByText(/^-R\s?900\.00$/);
    expect(balance.className).toContain('text-red-700 dark:text-red-400');
  });

  it('renders nothing for a job that is not this company\'s', async () => {
    vi.mocked(apiFetch).mockResolvedValue(ok([]));
    const { container } = render(<JobBudgetPanel jobId="job1" refreshKey="t1" />);
    await waitFor(() => expect(container.textContent).toBe(''));
  });
});

describe('Engagement Budgets report', () => {
  it('lists rows with the client\'s display name and a signed balance, and filters by client', async () => {
    vi.mocked(apiFetch).mockImplementation(async (url: unknown) => {
      if (urlOf(url).includes('/clients')) {
        return ok({ clients: [{ id: 'c1', legalName: 'Acme (Pty) Ltd', tradingName: 'Acme Trading' }] });
      }
      return ok(urlOf(url).includes('practiceClientId=c1')
        ? [row({ title: 'Only Acme' })]
        : [row({ title: 'Over job', balance: -900, state: 'over' }), row({ jobId: 'j2', title: 'No-budget job', budgetAmount: null, balance: null, percentUsed: null, state: 'none' })]);
    });
    render(<EngagementBudgetsPage />);
    const over = (await screen.findByText('Over job')).closest('tr')!;
    expect(within(over).getByText('Acme Trading')).toBeTruthy();
    expect(within(over).getByText(/^-R\s?900\.00$/).className).toContain('text-red-700');
    expect(within(over).getByText('Over budget')).toBeTruthy();
    expect(within(screen.getByText('No-budget job').closest('tr')!).getAllByText('No budget').length).toBeGreaterThan(0);

    await screen.findByRole('option', { name: 'Acme Trading' });
    fireEvent.change(screen.getByLabelText('Client'), { target: { value: 'c1' } });
    expect(await screen.findByText('Only Acme')).toBeTruthy();
    expect(screen.queryByText('Over job')).toBeNull();
  });
});

describe('job create: Engagement Budget field', () => {
  const route = (onPost: () => Response) => vi.mocked(apiFetch).mockImplementation(async (url: unknown, init?: unknown) => {
    const u = urlOf(url);
    if ((init as RequestInit | undefined)?.method === 'POST') return onPost();
    if (u.includes('/clients')) return ok({ clients: [{ id: 'c1', legalName: 'Acme (Pty) Ltd' }] });
    return ok([]);
  });
  const fill = async (budget: string) => {
    await screen.findByRole('option', { name: 'Acme (Pty) Ltd' });
    fireEvent.change(screen.getAllByRole('combobox')[0]!, { target: { value: 'c1' } });
    fireEvent.change(screen.getByPlaceholderText('e.g. FY2025 Annual Financial Statements'), { target: { value: 'AFS' } });
    fireEvent.change(screen.getByPlaceholderText('No budget'), { target: { value: budget } });
    fireEvent.submit(screen.getByRole('button', { name: /Save Job/ }).closest('form')!);
  };

  it('sends budgetAmount as a number', async () => {
    route(() => ok({ id: 'new1' }, 201));
    render(<NewPracticeJobPage />);
    await fill('2500.50');
    await waitFor(() => expect(vi.mocked(apiFetch).mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === 'POST')).toBe(true));
    const post = vi.mocked(apiFetch).mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'POST')!;
    expect(bodyOf(post)).toMatchObject({ practiceClientId: 'c1', title: 'AFS', budgetAmount: 2500.5 });
  });

  it('shows the refusal\'s own message', async () => {
    route(() => refused('Engagement budget must be an amount from 0 up to R9,999,999,999,999.99'));
    render(<NewPracticeJobPage />);
    await fill('1');
    expect(await screen.findByText(/Engagement budget must be an amount/)).toBeTruthy();
  });
});

describe('job edit: Engagement Budget field', () => {
  const JOB = {
    id: 'job1', companyId: 'co', practiceClientId: 'c1', jobCategoryId: null, title: 'AFS 2026', description: null,
    partnerId: null, preparerId: null, dueDate: null, priority: 'normal', status: 'in_progress', financialYear: null,
    billingType: null, budgetedHours: null, fixedFeeAmount: null, budgetAmount: 1000, startedAt: null, completedAt: null,
    createdBy: null, createdAt: '2026-01-01', updatedAt: '2026-01-01',
  };
  const puts = () => vi.mocked(apiFetch).mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === 'PUT');

  it('sends the new budget, then null once the field is cleared, and shows a refusal\'s message', async () => {
    let putResponse = () => ok(JOB);
    vi.mocked(apiFetch).mockImplementation(async (url: unknown, init?: unknown) => {
      const u = urlOf(url);
      if ((init as RequestInit | undefined)?.method === 'PUT') return putResponse();
      if (u.includes('engagement-budgets')) return ok([row({})]);
      if (u.includes('/users')) return ok([]);
      return ok(JOB);
    });
    render(<JobDetailPage />);
    const input = await screen.findByPlaceholderText('No budget');
    fireEvent.change(input, { target: { value: '2500' } });
    fireEvent.click(screen.getByRole('button', { name: /Save Changes/ }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(bodyOf(puts()[0]!).budgetAmount).toBe(2500);

    fireEvent.change(await screen.findByPlaceholderText('No budget'), { target: { value: '' } });
    putResponse = () => refused('This job has time entries for its current client, so it cannot be moved to another client');
    fireEvent.click(screen.getByRole('button', { name: /Save Changes/ }));
    await waitFor(() => expect(puts()).toHaveLength(2));
    expect(bodyOf(puts()[1]!).budgetAmount).toBeNull();
    expect(await screen.findByText(/time entries for its current client/)).toBeTruthy();
  });
});
