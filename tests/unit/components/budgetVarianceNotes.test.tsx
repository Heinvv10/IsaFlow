/**
 * Budgets P5 §3e/§5: the variance note on a Budget vs Actual line. The button and dialog offer what the
 * role may do (the server decides; tests/integration/budgets-p5-variance-routes.int.test.ts), and the page
 * loads the notes of the report's version for a ONE-month window only, keyed by account and filter.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { useState } from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { apiFetch } from '@/lib/apiFetch';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { ok } from '../helpers/d2R3a5';
import { trackingReport } from '../helpers/budgetTrackingReportFixture';
import { VarianceNoteButton } from '@/components/accounting/budgets/tracking/VarianceNoteButton';
import { useVarianceNotes } from '@/components/accounting/budgets/tracking/useVarianceNotes';
import { MAX_UNBUDGETED_CHARS } from '@/modules/accounting/services/commentary/commentaryLimits';
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

  it('an approved note seeds the owner editor from the signed wording, not its stale draft', async () => {
    const fns = button('owner', note({ status: 'approved', draftText: 'Old draft', approvedText: 'Signed edit' }));
    fireEvent.click(screen.getByRole('button', { name: /Approved variance note/ }));
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Signed edit');
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(fns.onSave).toHaveBeenCalledWith(SLICE, 'Signed edit'));
  });

  it('an owner approves or rejects the draft; a refusal stays on screen', async () => {
    const fns = button('owner', note({}), { onApprove: vi.fn(async () => 'Only an owner or admin can approve a variance note.') });
    fireEvent.click(screen.getByRole('button', { name: /Draft variance note/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Only an owner or admin');
    expect(fns.onApprove).toHaveBeenCalledWith('n1', 'Draft words'); // the text on screen, compared by the server
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(fns.onReject).toHaveBeenCalledWith('n1', 'Draft words'));
  });
});

describe('VarianceNoteButton: approve what is in the editor (review r2)', () => {
  it('an owner who edited the draft approves the edited text, with the shown draft as the stale check', async () => {
    const fns = button('owner', note({}));
    fireEvent.click(screen.getByRole('button', { name: /Draft variance note/ }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Owner wording.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(fns.onApprove).toHaveBeenCalledWith('n1', 'Draft words', 'Owner wording.'));
  });
  it('an owner who did not change the draft makes a plain approval', async () => {
    const fns = button('owner', note({}));
    fireEvent.click(screen.getByRole('button', { name: /Draft variance note/ }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '  Draft words \n' } }); // the same text once normalised
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(fns.onApprove).toHaveBeenCalledWith('n1', 'Draft words'));
  });
  it('the editor allows what the service stores (MAX_UNBUDGETED_CHARS), no less', () => {
    button('owner', note({}));
    fireEvent.click(screen.getByRole('button', { name: /Draft variance note/ }));
    expect(screen.getByRole('textbox').getAttribute('maxlength')).toBe(String(MAX_UNBUDGETED_CHARS));
  });
  it('writes are not offered when the notes failed to load (writable false)', () => {
    render(<VarianceNoteButton label="4000 Sales" slice={SLICE} note={undefined} role="owner" writable={false}
      onSave={vi.fn()} onApprove={vi.fn()} onReject={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /Add a variance note/ })).toBeNull();
  });
});

describe('VarianceNoteButton: the editor follows the reloaded note (browser proof r3)', () => {
  /** The page's shape: the note comes from the hook, which reloads it after a refused approve. */
  function Harness({ onApprove }: { onApprove: (id: string, shown: string, edited?: string) => Promise<string | null> }) {
    const [n, setN] = useState(note({ draftText: 'Old words' }));
    reload.current = (draftText: string) => setN(note({ draftText }));
    return <VarianceNoteButton label="4000 Sales" slice={SLICE} note={n} role="owner" onSave={vi.fn()} onApprove={onApprove} onReject={vi.fn()} />;
  }
  const reload = { current: (_: string) => undefined as void };

  it('a 409 reloads the note; the editor then holds the NEW draft, so a second Approve signs it (never the old wording)', async () => {
    const onApprove = vi.fn(async (_id: string, _shown: string, _edited?: string): Promise<string | null> => null)
      .mockImplementationOnce(async () => {
        act(() => reload.current('New words')); // the hook reloads before it answers the refusal
        return 'This note changed since you opened it, or is no longer a draft. Reload and review the new text.';
      });
    render(<Harness onApprove={onApprove} />);
    fireEvent.click(screen.getByRole('button', { name: /Draft variance note/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await screen.findByRole('alert');
    expect(onApprove).toHaveBeenNthCalledWith(1, 'n1', 'Old words');
    await waitFor(() => expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('New words'));
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(onApprove).toHaveBeenCalledTimes(2));
    expect(onApprove).toHaveBeenNthCalledWith(2, 'n1', 'New words');
  });

  it('an approver who EDITED and was refused (409) sees the reloaded draft, not their refused wording', async () => {
    const onApprove = vi.fn(async (_id: string, _shown: string, _edited?: string): Promise<string | null> => null)
      .mockImplementationOnce(async () => {
        act(() => reload.current('New words'));
        return 'This note changed since you opened it, or is no longer a draft. Reload and review the new text.';
      });
    render(<Harness onApprove={onApprove} />);
    fireEvent.click(screen.getByRole('button', { name: /Draft variance note/ }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Owner edit of the old draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await screen.findByRole('alert');
    expect(onApprove).toHaveBeenNthCalledWith(1, 'n1', 'Old words', 'Owner edit of the old draft');
    await waitFor(() => expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('New words'));
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(onApprove).toHaveBeenCalledTimes(2));
    expect(onApprove).toHaveBeenNthCalledWith(2, 'n1', 'New words');
  });

  it('a draft reloaded while the dialog is open replaces an untouched editor, but never what the user typed', async () => {
    render(<Harness onApprove={vi.fn(async () => null)} />);
    fireEvent.click(screen.getByRole('button', { name: /Draft variance note/ }));
    act(() => reload.current('Second draft'));
    await waitFor(() => expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Second draft'));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'My own edit' } });
    act(() => reload.current('Third draft'));
    await new Promise((r) => setTimeout(r, 20));
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('My own edit');
  });
});

describe('VarianceNoteButton: a refused save keeps what was typed', () => {
  it('the editor still holds the typed text after a save is refused', async () => {
    button('manager', note({}), { onSave: vi.fn(async () => 'A variance note is limited to 4000 characters.') });
    fireEvent.click(screen.getByRole('button', { name: /Draft variance note/ }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Typed, not yet saved' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await screen.findByRole('alert');
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Typed, not yet saved');
  });
});

describe('VarianceNoteButton: status colours are defined tokens (browser proof r3)', () => {
  const css = readFileSync(join(process.cwd(), 'styles/globals.css'), 'utf8');
  it('approved is the brand teal, dark and light, from tokens globals.css defines; draft amber; none grey', () => {
    button('viewer', note({ status: 'approved', approvedText: 'A', draftText: null }));
    const approved = screen.getByRole('button', { name: /Approved variance note/ }).className;
    expect(approved).toContain('text-[var(--ff-brand-dark)]');
    expect(approved).toContain('dark:text-[var(--ff-brand-light)]');
    for (const token of approved.match(/--ff-[a-z0-9-]+/g) ?? []) expect(css, `${token} is not defined`).toMatch(new RegExp(`${token}\\s*:`));
    cleanup();
    button('manager', note({}));
    expect(screen.getByRole('button', { name: /Draft variance note/ }).className).toContain('text-amber-600');
    cleanup();
    button('manager', undefined);
    expect(screen.getByRole('button', { name: /Add a variance note/ }).className).toContain('text-[var(--ff-text-tertiary)]');
  });
});

describe('useVarianceNotes (review r2)', () => {
  const A = { versionId: 'v-1', month: '2026-10' };
  const B = { versionId: 'v-1', month: '2026-11' };
  it('a scope change clears the previous scope\'s notes and is not ready until its own load lands', async () => {
    let release: () => void = () => undefined;
    vi.mocked(apiFetch).mockReset().mockImplementation(async (url) => {
      if (String(url).includes('month=2026-11')) await new Promise<void>((r) => { release = r; });
      return ok({ notes: [note({ status: 'approved', approvedText: 'October', draftText: null })] });
    });
    const { result, rerender } = renderHook(({ s }) => useVarianceNotes(s), { initialProps: { s: A } });
    await waitFor(() => expect(result.current.notes.size).toBe(1));
    expect(result.current.ready).toBe(true);
    rerender({ s: B });
    await waitFor(() => expect(result.current.notes.size).toBe(0));
    expect(result.current.ready).toBe(false);
    release();
    await waitFor(() => expect(result.current.ready).toBe(true));
  });
  it('a failed load is not ready, so the page offers no write', async () => {
    vi.mocked(apiFetch).mockReset().mockImplementation(async () => new Response('', { status: 500 }));
    const { result } = renderHook(() => useVarianceNotes(A));
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.ready).toBe(false);
  });
  it('the page offers no "Add a variance note" after a failed notes load', async () => {
    role.current = 'owner';
    const REPORT = trackingReport([{ code: '4000', name: 'Sales', type: 'revenue', actual: 5, budget: 10 }]);
    vi.mocked(apiFetch).mockReset().mockImplementation(async (url) =>
      (String(url).includes('variance-notes') ? new Response('', { status: 500 }) : ok(REPORT)));
    render(<BudgetVsActualPage />);
    await screen.findByRole('alert');
    expect(screen.queryByRole('button', { name: /Add a variance note/ })).toBeNull();
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
