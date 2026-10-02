/**
 * D2 round 7 (k2): close agent panel, link-tax-invoice button, dashboard stats hook, OCR vendor match.
 * A failed run load must not offer "Start close run" over a run that may exist; a good action whose refresh fails
 * says so and locks the stale rows; the accuracy strip is informational (logged, never an error).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { apiFetch } from '@/lib/apiFetch';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { MSG, bad, empty500, noRawText, ok, route } from '../helpers/d2R3a1Serve';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));

import { CloseAgentPanel } from '@/components/accounting/close-agent/CloseAgentPanel';
import { LinkTaxInvoiceButton } from '@/components/accounting/gl/LinkTaxInvoiceButton';
import { useDashboardStats } from '@/hooks/useDashboardStats';
import { matchVendorSupplier } from '@/components/accounting/supplier-invoices/matchVendorSupplier';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
beforeEach(() => { vi.mocked(apiFetch).mockReset(); });
afterEach(() => { cleanup(); });

const PERIODS = [{ id: 'p1', startDate: '2026-06-01', status: 'open' }];
const PROPOSAL = {
  id: 'pr1', closeRunId: 'r1', kind: 'unposted_journals', actionType: 'auto_post', title: 'D2 Proposal', reasoning: 'why',
  evidence: { summary: 's' }, targetEntityType: null, targetEntityId: null, status: 'proposed', decidedBy: null, decidedAt: null, result: null, createdAt: '2026-06-01',
};
const RUN = { run: { id: 'r1', companyId: 'c', fiscalPeriodId: 'p1', periodLabel: '2026-06', status: 'open', overallReadiness: null, createdBy: 'u', createdAt: '2026-06-01', completedAt: null }, proposals: [PROPOSAL] };
const ACC = { acceptanceRate: 0.5, proposed: 4, posted: 1, rejected: 1, failed: 0, dismissed: 0, decided: 2 };

type Answers = { run?: () => Response; acc?: () => Response; post?: () => Response };
const serve = (a: Answers = {}) => route((u, m) => {
  if (m === 'POST') return (a.post ?? (() => ok({})))();
  if (u.includes('fiscal-periods')) return ok(PERIODS);
  if (u.includes('close-run/accuracy')) return (a.acc ?? (() => ok(ACC)))();
  return (a.run ?? (() => ok(RUN)))();
});
const START = { name: /start close run/i };
const approve = () => screen.findByRole('button', { name: /approve/i });

describe('CloseAgentPanel run load', () => {
  it('a 404 is the legitimate "no run yet": Start is offered, no error', async () => {
    serve({ run: () => bad(404) });
    render(<CloseAgentPanel period="2026-06" />);
    expect(await screen.findByRole('button', START)).toBeTruthy();
    expect(screen.queryByText(MSG)).toBeNull();
  });
  it('a 400 shows the server message and does NOT offer Start over a run that may exist', async () => {
    serve({ run: () => bad(400) });
    render(<CloseAgentPanel period="2026-06" />);
    expect(await screen.findByText(MSG)).toBeTruthy();
    expect(screen.queryByRole('button', START)).toBeNull();
    expect(screen.queryByText(/No fiscal period exists/)).toBeNull();
  });
  it('an empty-500 shows a plain sentence, no Start and no stale proposals', async () => {
    serve({ run: empty500 });
    render(<CloseAgentPanel period="2026-06" />);
    expect(await screen.findByText('Could not load the close run - try again')).toBeTruthy();
    expect(screen.queryByRole('button', START)).toBeNull();
    expect(noRawText()).toBe(true);
  });
  it('a 200 shows the proposals and the accuracy strip', async () => {
    serve();
    render(<CloseAgentPanel period="2026-06" />);
    expect(await screen.findByText('D2 Proposal')).toBeTruthy();
    expect(await screen.findByText(/you accepted 1 of 2/)).toBeTruthy();
  });
  it('a failed accuracy strip is informational: the run still shows and no error appears', async () => {
    serve({ acc: empty500 });
    render(<CloseAgentPanel period="2026-06" />);
    expect(await screen.findByText('D2 Proposal')).toBeTruthy();
    expect(screen.queryByText(/Could not load/)).toBeNull();
    expect(screen.queryByText(/you accepted/)).toBeNull();
  });
});

describe('CloseAgentPanel action then refresh', () => {
  it('a refused decision shows the server message and keeps the buttons live', async () => {
    serve({ post: () => bad(400) });
    render(<CloseAgentPanel period="2026-06" />);
    fireEvent.click(await approve());
    expect(await screen.findByText(MSG)).toBeTruthy();
    expect((await approve() as HTMLButtonElement).disabled).toBe(false);
  });
  it('a good decision whose refresh fails says it was saved and locks the stale proposal (no stuck busy flag)', async () => {
    let posted = false;
    route((u, m) => {
      if (m === 'POST') { posted = true; return ok({}); }
      if (u.includes('fiscal-periods')) return ok(PERIODS);
      if (u.includes('close-run/accuracy')) return ok(ACC);
      return posted ? empty500() : ok(RUN);
    });
    render(<CloseAgentPanel period="2026-06" />);
    fireEvent.click(await approve());
    expect(await screen.findByText('The change was saved but the page could not refresh - reload it')).toBeTruthy();
    expect((await approve() as HTMLButtonElement).disabled).toBe(true);
    expect(noRawText()).toBe(true);
  });
  it('a good decision with a good refresh clears busy and shows no error', async () => {
    serve();
    render(<CloseAgentPanel period="2026-06" />);
    fireEvent.click(await approve());
    await waitFor(() => expect(vi.mocked(apiFetch).mock.calls.filter(([, i]) => i?.method === 'POST').length).toBe(1));
    await waitFor(() => expect(vi.mocked(apiFetch).mock.calls.length).toBeGreaterThanOrEqual(5));
    expect((await approve() as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText(/Could not|saved but/)).toBeNull();
  });
});

describe('LinkTaxInvoiceButton load', () => {
  const open = () => fireEvent.click(screen.getByText(/Link tax invoice/));
  it('a refused load shows the server message and clears the lists', async () => {
    route(() => bad(403));
    render(<LinkTaxInvoiceButton journalEntryId="je-1" />);
    open();
    expect(await screen.findByText(MSG)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Link' }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('an empty-500 load shows a plain sentence', async () => {
    route(() => empty500());
    render(<LinkTaxInvoiceButton journalEntryId="je-1" />);
    open();
    expect(await screen.findByText('Could not load the linked documents - try again')).toBeTruthy();
    expect(noRawText()).toBe(true);
  });
  it('a later good load drops the earlier error', async () => {
    let n = 0;
    route(() => (++n === 1 ? empty500() : ok({ links: [], candidates: [{ id: 'd1', fileName: 'inv.pdf', documentType: null }] })));
    render(<LinkTaxInvoiceButton journalEntryId="je-1" />);
    open();
    await screen.findByText('Could not load the linked documents - try again');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    open();
    expect(await screen.findByText(/inv\.pdf/)).toBeTruthy();
    expect(screen.queryByText(/Could not load/)).toBeNull();
  });
});

// The hook keeps a module-level cache: failures never populate it, so the failing cases run first, the 200 last.
describe('useDashboardStats', () => {
  it('a refused load surfaces the server message', async () => {
    route(() => bad(403));
    const { result } = renderHook(() => useDashboardStats());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe(MSG);
    expect(result.current.data).toBeNull();
  });
  it('an empty-500 load gives a plain sentence', async () => {
    route(() => empty500());
    const { result } = renderHook(() => useDashboardStats());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe('Could not load dashboard data - try again');
    expect(result.current.data).toBeNull();
  });
  it('a 200 returns the data and no error', async () => {
    route(() => ok({ revenue: 5 }));
    const { result } = renderHook(() => useDashboardStats());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeNull();
    expect(result.current.data).toEqual({ revenue: 5 });
  });
});

describe('matchVendorSupplier', () => {
  it('a refused search is a miss, not a match and not a throw', async () => {
    route(() => bad(500));
    expect(await matchVendorSupplier('Widget Works')).toBeNull();
  });
  it('a good search still matches', async () => {
    route(() => ok({ suppliers: [{ id: 's1', name: 'Widget Works (Pty) Ltd' }] }));
    expect(await matchVendorSupplier('Widget Works')).toBe('s1');
  });
});
