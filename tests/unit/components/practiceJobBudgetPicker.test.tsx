// The time entry form's optional Job select: after a client is chosen it lists
// that client's OPEN jobs, shows the chosen job's Engagement Budget and balance
// read-only (amber/red by state, "No budget" when none), and the entry is
// submitted with that jobId. A new client clears the job.
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JobBudgetRow } from '@/components/practice/practiceApi';

vi.mock('@/components/practice/practiceApi', () => ({
  fetchJobBudgets: vi.fn(),
  fetchWorkItems: vi.fn(async () => [{ id: 'wi1', name: 'Bookkeeping work' }]),
  fetchEntryTemplates: vi.fn(async () => []),
  createEntryTemplate: vi.fn(),
  resolveStaffRate: vi.fn(async () => 1000),
}));

import { fetchJobBudgets } from '@/components/practice/practiceApi';
import { JobBudgetPicker } from '@/components/practice/JobBudgetPicker';
import { TimeEntryForm } from '@/components/practice/TimeEntryForm';

const row = (over: Partial<JobBudgetRow>): JobBudgetRow => ({
  jobId: 'j', title: 'Job', jobStatus: 'in_progress', practiceClientId: 'c1', practiceClientName: 'Client',
  budgetAmount: 10000, consumedAmount: 7000, balance: 3000, budgetedHours: 20, hoursUsed: 7,
  percentUsed: 70, state: 'ok', ...over,
});

const JOBS: JobBudgetRow[] = [
  row({ jobId: 'warn', title: 'AFS 2026', budgetAmount: 1000, consumedAmount: 800, balance: 200, percentUsed: 80, state: 'warning' }),
  row({ jobId: 'over', title: 'Tax 2026', budgetAmount: 500, consumedAmount: 1000, balance: -500, percentUsed: 200, state: 'over' }),
  row({ jobId: 'none', title: 'Advisory', budgetAmount: null, balance: null, percentUsed: null, state: 'none' }),
  row({ jobId: 'done', title: 'Closed job', jobStatus: 'complete' }),
  row({ jobId: 'cxl', title: 'Cancelled job', jobStatus: 'cancelled' }),
  row({ jobId: 'bil', title: 'Billed job', jobStatus: 'billed' }),
];

afterEach(() => { vi.mocked(fetchJobBudgets).mockReset(); });

function renderPicker(jobId: string, onChange = vi.fn()) {
  return render(<JobBudgetPicker practiceClientId="c1" jobId={jobId} onChange={onChange} refreshKey={0}
    selectClassName="" labelClassName="" />);
}

describe('JobBudgetPicker', () => {
  it('lists only the client\'s open jobs', async () => {
    vi.mocked(fetchJobBudgets).mockResolvedValue(JOBS);
    renderPicker('');
    await screen.findByRole('option', { name: 'AFS 2026' });
    const names = screen.getAllByRole('option').map((o) => o.textContent);
    expect(names).toEqual(['No job', 'Advisory', 'AFS 2026', 'Tax 2026']);
    expect(fetchJobBudgets).toHaveBeenCalledWith('c1');
  });

  it('shows budget and balance read-only, amber at 80%', async () => {
    vi.mocked(fetchJobBudgets).mockResolvedValue(JOBS);
    renderPicker('warn');
    const box = await screen.findByTestId('engagement-budget');
    expect(box.getAttribute('data-state')).toBe('warning');
    expect(within(box).getByText('Engagement Budget')).toBeTruthy();
    expect(within(box).getByText('Engagement Budget Balance')).toBeTruthy();
    expect(within(box).getByText(/200\.00/)).toBeTruthy();
    expect(within(box).getByText(/80% or more/)).toBeTruthy();
    expect(box.querySelectorAll('input').length).toBe(0);
  });

  it('red when over, and saving is not blocked (no disabling)', async () => {
    vi.mocked(fetchJobBudgets).mockResolvedValue(JOBS);
    renderPicker('over');
    const box = await screen.findByTestId('engagement-budget');
    expect(box.getAttribute('data-state')).toBe('over');
    expect(within(box).getByText(/-.*500\.00/)).toBeTruthy();
    expect(within(box).getByText(/over budget\. Time can still be saved/)).toBeTruthy();
  });

  it('says "No budget" when the job has none, never R0', async () => {
    vi.mocked(fetchJobBudgets).mockResolvedValue(JOBS);
    renderPicker('none');
    const box = await screen.findByTestId('engagement-budget');
    expect(within(box).getAllByText('No budget')).toHaveLength(2);
  });
});

describe('TimeEntryForm job wiring', () => {
  it('submits the chosen jobId, and clears it when the client changes', async () => {
    vi.mocked(fetchJobBudgets).mockResolvedValue(JOBS);
    const onSubmit = vi.fn(async () => undefined);
    const { container } = render(
      <TimeEntryForm clients={[{ id: 'c1', legalName: 'Client One' }, { id: 'c2', legalName: 'Client Two' }]}
        categories={[{ id: 'cat1', name: 'Bookkeeping' }]} defaultDate="2026-01-12" currentUserId="u1" onSubmit={onSubmit} />,
    );
    const selects = () => container.querySelectorAll('select');
    const byFirstOption = (text: string) =>
      [...selects()].find((s) => s.options[0]?.textContent === text || [...s.options].some((o) => o.textContent === text))!;

    fireEvent.change(byFirstOption('Select client…'), { target: { value: 'c1' } });
    await screen.findByRole('option', { name: 'AFS 2026' });
    fireEvent.change(byFirstOption('AFS 2026'), { target: { value: 'warn' } });
    fireEvent.change(byFirstOption('Select category…'), { target: { value: 'cat1' } });
    await screen.findByRole('option', { name: 'Bookkeeping work' });
    fireEvent.change(byFirstOption('Bookkeeping work'), { target: { value: 'wi1' } });
    fireEvent.change(container.querySelector('input[type="number"]')!, { target: { value: '1.5' } });
    fireEvent.change(container.querySelector('input[placeholder="Describe the work done…"]')!, { target: { value: 'Work' } });
    fireEvent.submit(container.querySelector('form')!);
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({ practiceClientId: 'c1', jobId: 'warn', hours: 1.5 });

    fireEvent.change(byFirstOption('Select client…'), { target: { value: 'c2' } });
    await waitFor(() => expect((byFirstOption('AFS 2026') as HTMLSelectElement).value).toBe(''));
  });
});
