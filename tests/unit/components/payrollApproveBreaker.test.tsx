/**
 * BRK-596 adversarial UI repros (W3-01 review round 1), adopted as tests. Each
 * repro asserted the defect; each now asserts the fix. The preview fixtures
 * return what the server's approval gate now answers for that state (the gate
 * itself is pinned in tests/integration/brk596-approve-preview.int.test.ts).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import { RUN_URL, PLAN_URL, APPROVE_URL, runBody, planBody, ok, fail, approvedResult } from './payroll/payrollRunFixtures';

vi.mock('@/components/layout/AppLayout', () => ({
  AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('next/router', () => ({
  useRouter: () => ({ isReady: true, query: { id: '11111111-1111-4111-8111-111111111111' }, push: vi.fn() }),
}));
const company = vi.hoisted(() => ({ role: 'admin' }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: company.role }) }));

import PayrollRunDetailPage from '@/../pages/payroll/runs/[id]';

const fetchMock = vi.fn();
beforeEach(() => { company.role = 'admin'; fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const calls = (url: string) => fetchMock.mock.calls.filter(([u]) => String(u) === url);

function serve(approve: () => Response | Promise<Response>, preview: unknown = planBody(), run: unknown = runBody()) {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === APPROVE_URL && init?.method === 'POST') return approve();
    if (url === PLAN_URL) return ok(preview);
    if (url === RUN_URL) return ok(run);
    throw new Error(`unexpected fetch ${url}`);
  });
}

async function openDialog() {
  render(<PayrollRunDetailPage />);
  fireEvent.click(await screen.findByRole('button', { name: /review & approve/i }));
  return screen.findByRole('dialog');
}

describe('BRK-596 UI repros', () => {
  it('UI-1: repeated clicks, and closing and reopening while in flight, send ONE POST', async () => {
    let release!: () => void;
    serve(async () => { await new Promise<void>((r) => { release = r; }); return approvedResult('je-1'); });
    const dialog = await openDialog();
    await within(dialog).findByText('Other Employee Deductions Payable');
    const btn = within(dialog).getByRole('button', { name: /approve and post journal/i });
    fireEvent.click(btn); fireEvent.click(btn); fireEvent.click(btn);
    await waitFor(() => expect(calls(APPROVE_URL).length).toBeGreaterThan(0));
    fireEvent.click(within(dialog).getByRole('button', { name: /cancel/i }));
    fireEvent.click(await screen.findByRole('button', { name: /review & approve/i }));
    const d2 = await screen.findByRole('dialog');
    await within(d2).findByText('Other Employee Deductions Payable');
    fireEvent.click(within(d2).getByRole('button', { name: /approve and post journal/i }));
    expect(calls(APPROVE_URL)).toHaveLength(1);
    release();
  });

  it('UI-2: stale page (a peer already approved): the refusal is shown up front and Approve is disabled', async () => {
    const detail = "Cannot approve payroll run with status 'approved' (expected one of: draft, calculated, processed)";
    serve(() => fail(400, detail), planBody({ code: 'status_not_approvable', detail }, {
      plan: { status: 'approved', alreadyPostedJournalId: 'je-peer' },
    }));
    const dialog = await openDialog();
    expect(await within(dialog).findByText(detail)).toBeTruthy();
    expect(within(dialog).queryByText(/before it was reopened|posts nothing new/i)).toBeNull();
    expect((within(dialog).getByRole('button', { name: /approve/i, hidden: false }) as HTMLButtonElement).disabled).toBe(true);
    expect(calls(APPROVE_URL)).toHaveLength(0);
  });

  it('UI-3: reopened + recalculated run: no R0 "posts nothing new" journal; the drift refusal is shown and Approve is disabled', async () => {
    const detail = 'This run was recalculated after its journal posted, so its figures no longer match that journal — reverse the posted journal first.';
    serve(() => approvedResult('je-old'), planBody({ code: 'recalculated_after_posting', detail }, {
      plan: { alreadyPostedJournalId: 'je-old', lines: [], totalDebit: 0, totalCredit: 0 },
    }), runBody({ journalEntryId: 'je-old', totalGross: 0, totalNet: 0, totalPaye: 0, lines: [] }));
    const dialog = await openDialog();
    expect(await within(dialog).findByText(detail)).toBeTruthy();
    expect(within(dialog).queryByText(/posts nothing new/i)).toBeNull();
    expect((within(dialog).getAllByRole('button').find((b) => /approve/i.test(b.textContent ?? '')) as HTMLButtonElement).disabled).toBe(true);
    expect(calls(APPROVE_URL)).toHaveLength(0);
    expect(screen.queryByText(/payroll approved/i)).toBeNull();
  });

  it('UI-4: a viewer is not offered Review & approve', async () => {
    company.role = 'viewer';
    serve(() => fail(403, 'Your role (viewer) does not allow this action.'));
    render(<PayrollRunDetailPage />);
    await screen.findByText('Riaan Smit');
    expect(screen.queryByRole('button', { name: /review & approve/i })).toBeNull();
  });

  it('UI-5: a transport failure after the server may have committed reloads the run', async () => {
    serve(() => { throw new TypeError('Failed to fetch'); });
    const dialog = await openDialog();
    await within(dialog).findByText('Other Employee Deductions Payable');
    fireEvent.click(within(dialog).getByRole('button', { name: /approve and post journal/i }));
    expect(await within(dialog).findByText(/could not be confirmed/i)).toBeTruthy();
    await waitFor(() => expect(calls(RUN_URL).length).toBeGreaterThanOrEqual(2));
  });

  it('UI-6: a 502 HTML page from a proxy is not success, and the run is reloaded', async () => {
    serve(() => new Response('<html>Bad Gateway</html>', { status: 502 }));
    const dialog = await openDialog();
    await within(dialog).findByText('Other Employee Deductions Payable');
    fireEvent.click(within(dialog).getByRole('button', { name: /approve and post journal/i }));
    expect((await within(dialog).findByRole('alert')).textContent).toMatch(/could not be confirmed/i);
    await waitFor(() => expect(calls(RUN_URL).length).toBeGreaterThanOrEqual(2));
    expect(screen.queryByText(/payroll approved/i)).toBeNull();
  });
});
