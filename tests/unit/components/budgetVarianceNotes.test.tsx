/**
 * Budgets P5 §3e/§5: the variance note on a Budget vs Actual line. The button and dialog offer what the
 * role may do (the server decides; tests/integration/budgets-p5-variance-routes.int.test.ts), and the page
 * loads the notes of the report's version for a ONE-month window only, keyed by account and filter.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { apiFetch } from '@/lib/apiFetch';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { ok } from '../helpers/d2R3a5';
import { trackingReport } from '../helpers/budgetTrackingReportFixture';
import { VarianceNoteButton } from '@/components/accounting/budgets/tracking/VarianceNoteButton';
import type { VarianceNote, VarianceSlice } from '@/modules/accounting/services/commentary/varianceNoteTypes';

const role = vi.hoisted(() => ({ current: 'viewer' }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: role.current }) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, isReady: true, push: vi.fn(), replace: vi.fn(async () => true) }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/accounting/budgets/tracking/BudgetTrackingVisuals', () => ({ BudgetTrackingVisuals: () => null }));

import BudgetVsActualPage from '../../../pages/accounting/reports/budget-vs-actual';

useApiJsonOverMock();
afterEach(() => { cleanup(); role.current = 'viewer'; });

const SLICE: VarianceSlice = { glAccountId: '4000', cc1Id: null, cc2Id: null, buId: null };
const note = (over: Partial<VarianceNote>): VarianceNote => ({
  ...SLICE, id: 'n1', rowRef: '4000|||', status: 'draft', draftText: 'Draft words', approvedText: null, approvedBy: null, approvedAt: null, ...over,
});
function button(r: string, n: VarianceNote | undefined, actions: Partial<Record<'onSave' | 'onApprove' | 'onReject', ReturnType<typeof vi.fn>>> = {}) {
  const fns = { onSave: vi.fn(async () => null), onApprove: vi.fn(async () => null), onReject: vi.fn(async () => null), ...actions };
  render(<VarianceNoteButton label="4000 Sales" slice={SLICE} note={n} role={r} {...fns} />);
  return fns;
}

describe('VarianceNoteButton', () => {
  it('a viewer with no approved note is offered nothing; with one, reads it and can do nothing else', () => {
    button('viewer', undefined);
    expect(screen.queryByRole('button')).toBeNull();
    cleanup();
    button('viewer', note({ status: 'approved', draftText: null, approvedText: 'Approved words' }));
    fireEvent.click(screen.getByRole('button', { name: 'Approved variance note on 4000 Sales' }));
    expect(screen.getByText('Approved words')).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: /^(Approve|Reject|Save draft)$/ })).toBeNull();
  });

  it('a manager sees the draft labelled "Draft", edits and saves it, and is offered no Approve or Reject', async () => {
    const fns = button('manager', note({}));
    fireEvent.click(screen.getByRole('button', { name: 'Draft variance note on 4000 Sales' }));
    expect(screen.getByRole('region', { name: 'Draft note' }).textContent).toContain('Draft words');
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Better words' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(fns.onSave).toHaveBeenCalledWith(SLICE, 'Better words'));
  });

  it('a manager on an approved note is told an owner or admin changes it, and gets no editor', () => {
    button('manager', note({ status: 'approved', approvedText: 'Signed' }));
    fireEvent.click(screen.getByRole('button', { name: /Approved variance note/ }));
    expect(screen.getByText('An approved note can be changed by an owner or admin.')).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('an owner approves or rejects the draft; a refusal stays on screen', async () => {
    const fns = button('owner', note({}), { onApprove: vi.fn(async () => 'Only an owner or admin can approve a variance note.') });
    fireEvent.click(screen.getByRole('button', { name: /Draft variance note/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Only an owner or admin');
    expect(fns.onApprove).toHaveBeenCalledWith('n1');
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(fns.onReject).toHaveBeenCalledWith('n1'));
  });
});

describe('the Budget vs Actual page', () => {
  const REPORT = trackingReport([
    { code: '4000', name: 'Sales', type: 'revenue', actual: 5, budget: 10 },
    { code: '5000', name: 'Rent', type: 'expense', actual: 6, budget: 8 },
  ]);
  const notesCalls = () => vi.mocked(apiFetch).mock.calls.map(([u]) => String(u)).filter((u) => u.includes('variance-notes'));

  it('a one-month window loads the version\'s notes for that month and marks the line that has one', async () => {
    vi.mocked(apiFetch).mockReset().mockImplementation(async (url) => ok(String(url).includes('variance-notes')
      ? { notes: [note({ status: 'approved', draftText: null, approvedText: 'Sales slipped a week.' })] } : REPORT));
    render(<BudgetVsActualPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Approved variance note on 4000 Sales' }));
    expect(screen.getByText('Sales slipped a week.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /variance note on 5000/ })).toBeNull();
    expect(new URL(notesCalls()[0]!, 'http://x').search).toBe('?versionId=v-primary&month=2026-10');
  });

  it('a writer is offered a note on every line; the save names the line\'s account and the report filter', async () => {
    role.current = 'manager';
    const filtered = { ...REPORT, filter: { cc1: { id: 'cc-1', code: 'FT', name: 'Fibre' } } };
    vi.mocked(apiFetch).mockReset().mockImplementation(async (url) => ok(String(url).includes('variance-notes') ? { notes: [] } : filtered));
    render(<BudgetVsActualPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add a variance note on 5000 Rent' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Rent review' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(vi.mocked(apiFetch).mock.calls.some(([u, init]) => String(u).includes('variance-notes') && init?.method === 'POST')).toBe(true));
    const post = vi.mocked(apiFetch).mock.calls.find(([u, init]) => String(u).includes('variance-notes') && init?.method === 'POST')!;
    expect(JSON.parse(String(post[1]!.body))).toEqual({
      action: 'save', versionId: 'v-primary', month: '2026-10', glAccountId: '5000', cc1Id: 'cc-1', cc2Id: null, buId: null, text: 'Rent review',
    });
  });

  it('a window of more than one month loads no notes and offers none', async () => {
    role.current = 'owner';
    const quarter = { ...REPORT, window: { ...REPORT.window, period: 'quarter' as const, months: ['2026-09', '2026-10', '2026-11'] } };
    vi.mocked(apiFetch).mockReset().mockImplementation(async () => ok(quarter));
    render(<BudgetVsActualPage />);
    await screen.findByRole('button', { name: /Sales/ });
    await new Promise((r) => setTimeout(r, 30));
    expect(notesCalls()).toEqual([]);
    expect(screen.queryByRole('button', { name: /variance note/ })).toBeNull();
  });
});
