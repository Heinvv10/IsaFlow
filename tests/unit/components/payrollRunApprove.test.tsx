/**
 * W3-01 (PAY-01, PAY-24): a calculated pay run can be approved from its page.
 * The confirmation shows what the server's approval gate says approval will
 * do. The POST carries the previewed planHash. A refusal is shown and never
 * claimed as success, and the run links to the journal it posted.
 *
 * `fetch` is stubbed, not `apiFetch`: the real apiFetch/apiJson/assertOk run,
 * so a 4xx that apiFetch resolves on is proven to reach the operator.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import {
  RUN_ID, RUN_URL, PLAN_URL, APPROVE_URL, PLAN_HASH, line, runBody, planBody, postedJournal, ok, fail, approvedResult,
} from './payroll/payrollRunFixtures';

vi.mock('@/components/layout/AppLayout', () => ({
  AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
const routerQuery = vi.hoisted(() => ({ id: '11111111-1111-4111-8111-111111111111' }));
vi.mock('next/router', () => ({ useRouter: () => ({ isReady: true, query: { ...routerQuery }, push: vi.fn() }) }));
const company = vi.hoisted(() => ({ role: 'admin' as string | null }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: company.role }) }));

import PayrollRunDetailPage from '@/../pages/payroll/runs/[id]';

const fetchMock = vi.fn();
beforeEach(() => {
  routerQuery.id = RUN_ID;
  company.role = 'admin';
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const calls = (url: string) => fetchMock.mock.calls.filter(([u]) => String(u) === url);

/** Serve the run (before/after approval), the preview, and the given approve answer. */
function serve(approve: () => Response | Promise<Response>, opts: { preview?: unknown; after?: () => Response | Promise<Response> } = {}) {
  let approved = false;
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === APPROVE_URL && init?.method === 'POST') { const r = await approve(); approved = r.ok; return r; }
    if (url === PLAN_URL) return ok(opts.preview ?? planBody());
    if (url === RUN_URL) return approved && opts.after ? opts.after() : ok(runBody(approved ? { status: 'approved', journalEntryId: 'je-123' } : {}));
    throw new Error(`unexpected fetch ${url}`);
  });
}

async function openAndConfirm(button = /approve and post journal/i) {
  render(<PayrollRunDetailPage />);
  fireEvent.click(await screen.findByRole('button', { name: /review & approve/i }));
  const dialog = await screen.findByRole('dialog');
  const confirm = await within(dialog).findByRole('button', { name: button });
  await waitFor(() => expect((confirm as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(confirm);
  return dialog;
}

describe('payroll run page — approve (PAY-01)', () => {
  it('a calculated run offers Review & approve, shows the journal, and POSTs /approve with the previewed hash', async () => {
    serve(() => approvedResult('je-123'));
    render(<PayrollRunDetailPage />);
    fireEvent.click(await screen.findByRole('button', { name: /review & approve/i }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('Other Employee Deductions Payable')).toBeTruthy();
    expect(within(dialog).getAllByText(/75[\s ]927,12/).length).toBeGreaterThan(0);
    fireEvent.click(within(dialog).getByRole('button', { name: /approve and post journal/i }));

    await waitFor(() => expect(calls(APPROVE_URL)).toHaveLength(1));
    const init = calls(APPROVE_URL)[0]![1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ expectedPlanHash: PLAN_HASH });
    expect(await screen.findByText(/approved and journal posted/i)).toBeTruthy();
    expect((await screen.findByRole('link', { name: /view journal/i })).getAttribute('href')).toBe('/accounting/journal-entries/je-123');
  });

  it('a 409 (run changed since the preview) shows why, refetches the preview, and claims nothing', async () => {
    serve(() => fail(409, 'Payroll run changed while you were reviewing it'));
    const dialog = await openAndConfirm();
    expect(await within(dialog).findByText(/Payroll run changed while you were reviewing it/)).toBeTruthy();
    await waitFor(() => expect(calls(PLAN_URL)).toHaveLength(2));
    expect(calls(APPROVE_URL)).toHaveLength(1);
    expect(screen.queryByRole('link', { name: /view journal/i })).toBeNull();
    expect(screen.queryByText(/approved and journal posted/i)).toBeNull();
  });

  it('any other refusal (400) is shown and the preview is refetched, so a rejected plan never lingers', async () => {
    serve(() => fail(400, "Cannot approve payroll run with status 'approved' (expected one of: draft, calculated, processed)"));
    const dialog = await openAndConfirm();
    expect(await within(dialog).findByText(/Cannot approve payroll run with status 'approved'/)).toBeTruthy();
    await waitFor(() => expect(calls(PLAN_URL)).toHaveLength(2));
    expect(screen.queryByText(/payroll approved/i)).toBeNull();
  });

  it('a transport failure reloads the run and says the outcome is unknown', async () => {
    serve(() => { throw new TypeError('Failed to fetch'); });
    const dialog = await openAndConfirm();
    expect(await within(dialog).findByText(/could not be confirmed/i)).toBeTruthy();
    await waitFor(() => expect(calls(RUN_URL).length).toBeGreaterThanOrEqual(2));
    expect(screen.queryByText(/approved and journal posted/i)).toBeNull();
  });

  it('a plan blocker is shown and approval is not offered', async () => {
    const detail = "The fiscal period covering 2026-09-30 is 'closed', so the payroll journal cannot post into it.";
    serve(() => approvedResult('je-1'), { preview: planBody({ code: 'closed_period', detail }) });
    render(<PayrollRunDetailPage />);
    fireEvent.click(await screen.findByRole('button', { name: /review & approve/i }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText(detail)).toBeTruthy();
    expect((within(dialog).getByRole('button', { name: /approve and post journal/i }) as HTMLButtonElement).disabled).toBe(true);
    expect(calls(APPROVE_URL)).toHaveLength(0);
  });

  it('a reopened run shows the journal already posted and, once approved, says no new journal was posted', async () => {
    serve(() => approvedResult('je-old'), {
      preview: planBody(null, { plan: { alreadyPostedJournalId: 'je-old' }, posted: postedJournal('je-old') }),
    });
    const dialog = await openAndConfirm(/approve \(no new journal\)/i);
    expect(within(dialog).getByText(/already posted: journal/i)).toBeTruthy();
    expect(await screen.findByText(/approved — no new journal posted/i)).toBeTruthy();
    expect(screen.queryByText(/approved and journal posted/i)).toBeNull();
  });

  it('a draft run has nothing to approve', async () => {
    serve(() => approvedResult('je-1'));
    fetchMock.mockImplementation(async () => ok(runBody({ status: 'draft', lines: [] })));
    render(<PayrollRunDetailPage />);
    await screen.findByRole('button', { name: /^calculate$/i });
    expect(screen.queryByRole('button', { name: /review & approve/i })).toBeNull();
  });

  it.each(['viewer', null])('role %s is not offered Review & approve', async (role) => {
    company.role = role;
    serve(() => approvedResult('je-1'));
    render(<PayrollRunDetailPage />);
    await screen.findByText('Riaan Smit');
    expect(screen.queryByRole('button', { name: /review & approve/i })).toBeNull();
  });

  it('an approved run links the journal it posted (PAY-24)', async () => {
    fetchMock.mockImplementation(async () => ok(runBody({ status: 'approved', journalEntryId: 'je-77' })));
    render(<PayrollRunDetailPage />);
    expect((await screen.findByRole('link', { name: /view journal/i })).getAttribute('href')).toBe('/accounting/journal-entries/je-77');
  });
});

describe('payroll run page — after approval (review round 1)', () => {
  it('keeps the run on screen while it reloads after approval', async () => {
    serve(() => approvedResult('je-123'), { after: () => new Promise<Response>(() => {}) });
    await openAndConfirm();
    expect(await screen.findByText(/approved and journal posted/i)).toBeTruthy();
    expect(screen.getByText('Riaan Smit')).toBeTruthy();
    expect(screen.getByRole('link', { name: /view journal/i }).getAttribute('href')).toBe('/accounting/journal-entries/je-123');
  });

  it('approve succeeds, reload fails: the approval stands and the refresh failure is said plainly', async () => {
    serve(() => approvedResult('je-123'), { after: () => fail(500, 'boom') });
    await openAndConfirm();
    expect(await screen.findByText(/could not refresh this run/i)).toBeTruthy();
    expect(screen.getByText(/approved and journal posted/i)).toBeTruthy();
    expect(screen.getByText('Riaan Smit')).toBeTruthy();
    expect(screen.getByRole('link', { name: /view journal/i }).getAttribute('href')).toBe('/accounting/journal-entries/je-123');
    expect(screen.queryByText(/failed to load run/i)).toBeNull();
  });

  it('navigating to another run never shows the previous run while the new one loads', async () => {
    const OTHER = '22222222-2222-4222-8222-222222222222';
    serve(() => approvedResult('je-123'));
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => (url === `/api/payroll/runs/${OTHER}`
      ? new Promise<Response>(() => {})
      : base(url, init)));
    const view = render(<PayrollRunDetailPage />);
    await screen.findByText('Riaan Smit');
    routerQuery.id = OTHER;
    view.rerender(<PayrollRunDetailPage />);
    await waitFor(() => expect(screen.queryByText('Riaan Smit')).toBeNull());
  });

  it('clears the approval notice on navigating to another run', async () => {
    const OTHER = '22222222-2222-4222-8222-222222222222';
    serve(() => approvedResult('je-123'));
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => (url === `/api/payroll/runs/${OTHER}`
      ? ok(runBody({ id: OTHER, periodMonth: 10, lines: [line('9', 'Other Person')] }))
      : base(url, init)));
    const view = render(<PayrollRunDetailPage />);
    fireEvent.click(await screen.findByRole('button', { name: /review & approve/i }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('Other Employee Deductions Payable');
    fireEvent.click(within(dialog).getByRole('button', { name: /approve and post journal/i }));
    expect(await screen.findByText(/approved and journal posted/i)).toBeTruthy();

    routerQuery.id = OTHER;
    view.rerender(<PayrollRunDetailPage />); // same mounted page, new route
    expect(await screen.findByText('Other Person')).toBeTruthy();
    expect(screen.queryByText(/approved and journal posted/i)).toBeNull();
    expect(screen.queryByText('Riaan Smit')).toBeNull();
  });
});
