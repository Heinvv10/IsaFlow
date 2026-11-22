/**
 * Pages outside the nav that link into Payroll (an approval request for a pay run, an auto-posted payroll entry, the
 * EMP201 drill, the portfolio's Payroll column) follow the same answer as the nav (`useNavFlags`): without Payroll read
 * the link is plain text / the column is gone; with it, as before. The API still decides access.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';

const h = vi.hoisted(() => ({ flags: new Set<string>() as ReadonlySet<string>, apiFetch: vi.fn() }));
vi.mock('@/hooks/useNavFlags', () => ({ useNavFlags: () => h.flags }));
vi.mock('next/router', () => ({ useRouter: () => ({ push: vi.fn(), pathname: '/', asPath: '/', query: {} }) }));
vi.mock('next/link', () => ({ default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/apiFetch', async (orig) => ({ ...(await orig<typeof import('@/lib/apiFetch')>()), apiFetch: h.apiFetch }));

import ApprovalsPage from '../../../pages/accounting/approvals';
import AutoPostingsPage from '../../../pages/accounting/auto-postings';
import PortfolioWorkbenchPage from '../../../pages/accounting/portfolio-workbench';
import MonthEndWorkbenchPage from '../../../pages/accounting/month-end-workbench';
import { Emp201ReturnForm } from '@/components/accounting/sars/emp201/Emp201ReturnForm';
import { MODULE_READ_NAV_FLAGS } from '@/components/accounting/navSections/flagNav';

const CAN: ReadonlySet<string> = new Set(MODULE_READ_NAV_FLAGS);
const CANNOT: ReadonlySet<string> = new Set();
const RUN = '11111111-1111-4111-8111-111111111111';
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

beforeEach(() => { h.apiFetch.mockReset(); h.flags = CANNOT; });
afterEach(cleanup);

describe('Approvals: a pay run request', () => {
  const answer = () => h.apiFetch.mockImplementation(async (url: string) => {
    if (String(url).startsWith('/api/accounting/approval-requests')) {
      return json({ data: { items: [{ id: '1', ruleName: 'r', documentType: 'pay_run', documentId: RUN, documentReference: 'RUN-2026-09',
        amount: 100, documentDigest: 'a'.repeat(64), status: 'pending', requestedByName: 'Q', requestedAt: '2026-10-06T08:00:00Z', decidedAt: null, decisionNotes: null }] } });
    }
    return json({ data: { items: [] } });
  });
  it('is plain text without Payroll read', async () => {
    answer();
    render(<ApprovalsPage />);
    await screen.findByText('RUN-2026-09');
    expect(screen.queryByRole('link', { name: 'RUN-2026-09' })).toBeNull();
  });
  it('links to the run with Payroll read', async () => {
    h.flags = CAN; answer();
    render(<ApprovalsPage />);
    expect((await screen.findByRole('link', { name: 'RUN-2026-09' })).getAttribute('href')).toBe(`/payroll/runs/${RUN}`);
  });
});

describe('Auto-postings: an auto payroll entry', () => {
  const answer = () => h.apiFetch.mockImplementation(async () => json({ data: {
    total: 1, breakdown: {},
    entries: [{ id: 'je1', entryNumber: 'JE-1', entryDate: '2026-09-30', source: 'auto_payroll', description: 'Payroll', lineCount: 2, totalDebit: 10, totalCredit: 10, sourceDocumentId: RUN }],
  } }));
  it('has no Open link to the run without Payroll read', async () => {
    answer();
    render(<AutoPostingsPage />);
    await screen.findByText('JE-1');
    expect(screen.queryByRole('link', { name: 'Open' })).toBeNull();
  });
  it('has it with Payroll read', async () => {
    h.flags = CAN; answer();
    render(<AutoPostingsPage />);
    expect((await screen.findByRole('link', { name: 'Open' })).getAttribute('href')).toBe(`/payroll/runs/${RUN}`);
  });
});

describe('EMP201 drill: the pay run links', () => {
  const data = {
    periodStart: '2026-09-01', periodEnd: '2026-09-30', totalPAYE: 1500, totalETI: 0, payePayable: 1200,
    etiCarry: { broughtForward: 0, used: 0, carriedForward: 0, refundClaimable: 0 },
    totalUIF_employee: 100, totalUIF_employer: 100, totalUIF: 200, totalSDL: 0, employeeCount: 2,
    totalTaxableRemuneration: 30000, totalDeductions: 1700, payrollRuns: [], directivePayments: [],
  };
  const drill = {
    field: 'paye', periodStart: '2026-09-01', periodEnd: '2026-09-30', total: 1500, rowsTotal: 1500, ties: true,
    runs: [{ runId: RUN, periodYear: 2026, periodMonth: 9, status: 'approved', headerTotal: 1500, linesTotal: 1500, difference: 0 }],
    directivePayments: [], page: 1, pageSize: 200, rowCount: 1, hasMore: false,
    rows: [{ runId: RUN, periodYear: 2026, periodMonth: 9, employeeId: 'e1', employeeNumber: 'E1', employeeName: 'Emp 1', amount: 750 }],
  };
  const open = async () => {
    h.apiFetch.mockResolvedValue({ ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify({ data: drill }), json: async () => ({ data: drill }) });
    render(<Emp201ReturnForm data={data as never} canDrill />);
    fireEvent.click(screen.getByLabelText('Show the lines behind PAYE (Pay As You Earn)'));
    return screen.findByTestId('return-drill-lines');
  };
  it('are plain month text without Payroll read, in the runs and the lines tables', async () => {
    const lines = await open();
    expect(within(lines).getByText('2026-09')).toBeTruthy();
    expect(within(lines).queryAllByRole('link')).toEqual([]);
    expect(within(screen.getByTestId('emp201-drill-runs')).queryAllByRole('link')).toEqual([]);
  });
  it('are links with Payroll read', async () => {
    h.flags = CAN;
    const lines = await open();
    expect(within(lines).getAllByRole('link').map((l) => l.getAttribute('href'))).toEqual([`/payroll/runs/${RUN}`]);
    expect(within(screen.getByTestId('emp201-drill-runs')).getAllByRole('link')).toHaveLength(1);
  });
});

describe('Portfolio: Payroll is decided per client row by the server', () => {
  const card = (id: string, title: string) => ({ id, title, status: 'ready', primary: `${title} ok` });
  const mk = (id: string, name: string, extra: Record<string, unknown>) => ({
    companyId: id, companyName: name, isDefault: false, role: 'admin', trialBalanceBalanced: true, attentionCount: 0, blockedCount: 0, failed: false, ...extra,
  });
  const readable = mk('c1', 'Readable Client', { readyCount: 2, cards: [card('banking', 'Bank'), card('payroll', 'Payroll')] });
  const hidden = mk('c2', 'Hidden Client', { readyCount: 1, cards: [card('banking', 'Bank')], payrollHidden: true });
  const answer = () => h.apiFetch.mockImplementation(async () => json({ success: true, data: { userId: 'u', period: '2026-09', rows: [readable, hidden], generatedAt: '2026-10-01T00:00:00Z',
    summary: { totalClients: 2, clientsAtRisk: 0, cardsByStatus: { ready: 3, in_progress: 0, attention: 0, blocked: 0, not_started: 0 } } } }));

  it('shows the Payroll card for a client where it is readable and "No access" where it is not, whatever the active company can read', async () => {
    h.flags = CANNOT; // the ACTIVE company's Payroll read is irrelevant: each row carries its own
    answer();
    render(<PortfolioWorkbenchPage />);
    await screen.findByText('Hidden Client');
    const rowOf = (name: string) => screen.getByText(name).closest('tr')!;
    expect(within(rowOf('Hidden Client')).getByText('No access')).toBeTruthy();
    expect(within(rowOf('Hidden Client')).getByText('1/7')).toBeTruthy();
    expect(within(rowOf('Readable Client')).queryByText('No access')).toBeNull();
    expect(within(rowOf('Readable Client')).getByText('2/8')).toBeTruthy();
    expect(screen.getByTitle('Payroll')).toBeTruthy(); // the column header stays
  });
});

describe('Month-end workbench: the single company', () => {
  const card = (id: string, title: string) => ({ id, title, status: 'ready', primary: `${title} ok` });
  const answer = (extra: Record<string, unknown>, ids: string[]) => h.apiFetch.mockImplementation(async () => json({ success: true, data: {
    companyId: 'c', period: '2026-09', periodStart: '2026-09-01', periodEnd: '2026-09-30', generatedAt: '2026-10-01T00:00:00Z',
    cards: ids.map((i) => card(i, i === 'vat' ? 'VAT Readiness' : i === 'payroll' ? 'Payroll Run' : i)), trialBalanceBalanced: true, trialBalanceDiff: 0, ...extra } }));

  it('says "No access" in the payroll place, and the ready count is out of the cards it was given', async () => {
    answer({ payrollHidden: true }, ['banking', 'vat', 'afs']);
    render(<MonthEndWorkbenchPage />);
    const tile = await screen.findByTestId('no-access-tile');
    expect(tile.textContent).toMatch(/No access/);
    expect(screen.getAllByText('Payroll Run')).toHaveLength(1);
    expect(document.body.textContent).toMatch(/3\s*of\s*3 areas ready/);
  });

  it('shows the payroll card and no placeholder with Payroll read', async () => {
    answer({}, ['banking', 'vat', 'payroll', 'afs']);
    render(<MonthEndWorkbenchPage />);
    await screen.findAllByText('Payroll Run');
    expect(screen.queryByTestId('no-access-tile')).toBeNull();
  });
});
