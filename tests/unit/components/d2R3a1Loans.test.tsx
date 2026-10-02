/**
 * D2 round 3 (a1): loan period close, loan detail rate curve, netcash status poll, PIS score save.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { MSG, bad, empty500, noRawText, ok, route, spinning } from '../helpers/d2R3a1Serve';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: { id: 'loan-1' }, push: vi.fn() }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/ui', () => ({ PageHeader: () => null }));
const company = vi.hoisted(() => ({ activeCompany: { id: 'co-1' } }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => company }));
vi.mock('@/components/loans/LoanStatusBadge', () => ({ LoanStatusBadge: () => null }));
vi.mock('@/components/loans/LoanOverviewTab', () => ({ LoanOverviewTab: () => <div>overview</div> }));
vi.mock('@/components/loans/LoanScheduleTab', () => ({ LoanScheduleTab: () => null }));
vi.mock('@/components/loans/LoanEventsTab', () => ({ LoanEventsTab: () => null }));
vi.mock('@/components/loans/LoanComplianceTab', () => ({ LoanComplianceTab: () => null }));
vi.mock('@/components/loans/LoanRateCurveTab', () => ({
  LoanRateCurveTab: ({ loading, points }: { loading: boolean; points: unknown[] }) => <div>CURVE {loading ? 'LOADING' : 'IDLE'} {points.length} points</div>,
}));

import LoanPeriodClosePage from '../../../pages/accounting/loans/period-close';
import LoanDetailPage from '../../../pages/accounting/loans/[id]';
import NetcashSubmissionsPage from '../../../pages/accounting/netcash/index';
import PisScorePage from '../../../pages/accounting/afs/pis-score';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
afterEach(() => { cleanup(); });

const LOAN_ROW = { loanId: 'l1', reference: 'LN-D2-1', description: null, product: null, principalBalance: 1000, rateMode: 'FIXED',
  margin: 0, fixedRate: 10, nextPaymentDate: null, accruedInterest: 5, periodStatus: 'open' };
const PERIOD = { yyyymm: '202601', month: 1, year: 2026, locked: false, loans: [LOAN_ROW] };

describe('loan period close', () => {
  /** GETs: first ok(PERIOD), then `reload()`; the POST answers `post()`. */
  function open(post: () => Response, reload: () => Response = () => ok(PERIOD)) {
    let gets = 0;
    route((_u, method) => {
      if (method === 'POST') return post();
      gets += 1; return gets === 1 ? ok(PERIOD) : reload();
    });
    render(<LoanPeriodClosePage />);
  }
  const post = async () => fireEvent.click(await screen.findByRole('button', { name: /^Post$/ }));

  it('post 200 then reload 500 keeps "Journal posted successfully", shows the reload error, no spinner', async () => {
    open(() => ok({ yyyymm: '202601', posted: [{ loanId: 'l1', journalEntryId: 'j1', narrative: 'n' }], errors: [] }), empty500);
    await post();
    expect(await screen.findByText(/Journal posted successfully/)).toBeTruthy();
    expect(await screen.findByText(/Could not load period data - try again/)).toBeTruthy();
    expect(noRawText()).toBe(true);
    await waitFor(() => expect(spinning()).toBe(false));
    expect(screen.queryByText('LN-D2-1')).toBeNull();
  });
  it('post-all 200 then reload 500 keeps "Posted journals for N", shows the reload error', async () => {
    open(() => ok({ yyyymm: '202601', posted: [{ loanId: 'l1', journalEntryId: 'j1', narrative: 'n' }], errors: [] }), empty500);
    await screen.findByText('LN-D2-1'); // the bulk button is disabled until the rows have loaded
    fireEvent.click(screen.getByRole('button', { name: /Post All|Post all/ }));
    expect(await screen.findByText(/Posted journals for 1 loan/)).toBeTruthy();
    expect(await screen.findByText(/Could not load period data - try again/)).toBeTruthy();
    await waitFor(() => expect(spinning()).toBe(false));
  });
  it('a refused post shows the server message and no success', async () => {
    open(() => bad());
    await post();
    expect(await screen.findByText(new RegExp(MSG))).toBeTruthy();
    expect(screen.queryByText(/Journal posted successfully/)).toBeNull();
  });
  it('a failed first load shows a plain sentence, no stale loans, no spinner', async () => {
    route(() => empty500());
    render(<LoanPeriodClosePage />);
    expect(await screen.findByText(/Could not load period data - try again/)).toBeTruthy();
    expect(noRawText()).toBe(true);
    await waitFor(() => expect(spinning()).toBe(false));
  });
  it('changing the period to one that fails clears the old rows', async () => {
    let gets = 0;
    route(() => { gets += 1; return gets === 1 ? ok(PERIOD) : bad(); });
    const { container } = render(<LoanPeriodClosePage />);
    expect(await screen.findByText('LN-D2-1')).toBeTruthy();
    fireEvent.change(container.querySelectorAll('select')[0]!, { target: { value: '2' } });
    expect(await screen.findByText(new RegExp(MSG))).toBeTruthy();
    expect(screen.queryByText('LN-D2-1')).toBeNull();
  });
});

describe('loan detail rate curve', () => {
  const LOAN = { id: 'loan-1', reference: 'LN-D2-1', status: 'active', product: null, description: null, curveId: 'cv1' };
  function open(curves: () => Response, points: () => Response) {
    route((url) => {
      if (url.includes('/loan-rate-curves/cv1/points')) return points();
      if (url.includes('/loan-rate-curves')) return curves();
      return ok(LOAN);
    });
    render(<LoanDetailPage />);
  }
  const goCurve = async () => fireEvent.click(await screen.findByRole('button', { name: 'Rate Curve' }));

  it('an empty-500 curve answer shows a plain sentence and clears the loading flag', async () => {
    open(empty500, () => ok([]));
    await goCurve();
    expect(await screen.findByText(/Could not load the rate curve - try again/)).toBeTruthy();
    expect(noRawText()).toBe(true);
    expect(await screen.findByText(/CURVE IDLE 0 points/)).toBeTruthy();
  });
  it('a refused points call shows the server message and clears the loading flag', async () => {
    open(() => ok([{ id: 'cv1', name: 'D2 curve' }]), () => bad());
    await goCurve();
    expect(await screen.findByText(new RegExp(MSG))).toBeTruthy();
    expect(await screen.findByText(/CURVE IDLE 0 points/)).toBeTruthy();
  });
  it('a good answer loads the points', async () => {
    open(() => ok([{ id: 'cv1', name: 'D2 curve' }]), () => ok([{ id: 'p1' }, { id: 'p2' }]));
    await goCurve();
    expect(await screen.findByText(/CURVE IDLE 2 points/)).toBeTruthy();
  });
});

describe('netcash status poll', () => {
  const SUB = { id: 's1', submission_type: 'eft_payment', status: 'submitted', batch_reference: 'B-D2', total_amount_cents: 100,
    record_count: 1, submitted_at: '2026-01-01', created_at: '2026-01-01', created_by: null };
  const open = (status: () => Response) => {
    route((url) => (url.includes('/netcash/status') ? status() : ok({ items: [SUB], total: 1 })));
    render(<NetcashSubmissionsPage />);
  };
  it('a refused status check shows the server message', async () => {
    open(() => bad());
    fireEvent.click(await screen.findByRole('button', { name: /Check status/ }));
    expect(await screen.findByText(new RegExp(MSG))).toBeTruthy();
  });
  it('an empty 500 status check shows a plain sentence', async () => {
    open(empty500);
    fireEvent.click(await screen.findByRole('button', { name: /Check status/ }));
    expect(await screen.findByText(/Could not check the submission status - try again/)).toBeTruthy();
    expect(noRawText()).toBe(true);
    await waitFor(() => expect(spinning()).toBe(false));
  });
  it('a failed list load clears the old rows', async () => {
    let lists = 0;
    route((url) => (url.includes('/netcash/status') ? ok({}) : (lists += 1) === 1 ? ok({ items: [SUB], total: 1 }) : empty500()));
    render(<NetcashSubmissionsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Check status/ }));
    expect(await screen.findByText(/Could not load submissions - try again/)).toBeTruthy();
    expect(screen.queryByText('B-D2')).toBeNull();
  });
});

describe('PIS score save', () => {
  const PIS = { fiscalYear: 2031, fiscalYearStart: '2031-03-01', fiscalYearEnd: '2032-02-28',
    employees: { beginning: 3, end: 4, average: 4, points: 4 }, turnover: { amount: 1000, points: 1 },
    thirdPartyLiabilities: { amount: 500, points: 1 }, shareholders: { count: 2, points: 2 }, totalScore: 8,
    allShareholdersAreDirectors: true, reportingRequirement: 'independent_review', requiredFramework: 'ifrs_sme',
    requiredCipcFiling: 'afs_required', dataUnavailable: [], calculatedAt: '2031-03-01' };
  function open(put: () => Response, reload: () => Response = () => ok(PIS)) {
    let gets = 0;
    route((_u, method) => { if (method === 'PUT') return put(); gets += 1; return gets === 1 ? ok(PIS) : reload(); });
    render(<PisScorePage />);
  }
  const save = async () => fireEvent.click(await screen.findByRole('button', { name: /Save & Recalculate/ }));

  it('a refused save shows the server message and never claims success', async () => {
    open(() => bad());
    await save();
    expect(await screen.findByText(new RegExp(MSG))).toBeTruthy();
    expect(screen.queryByText(/PIS score updated successfully|PIS inputs saved/)).toBeNull();
  });
  it('an empty 500 save shows a plain sentence and never claims success', async () => {
    open(empty500);
    await save();
    expect(await screen.findByText(/Could not save the PIS inputs - try again/)).toBeTruthy();
    expect(noRawText()).toBe(true);
    expect(screen.queryByText(/PIS score updated successfully|PIS inputs saved/)).toBeNull();
  });
  it('save 200 then recalculation 500 does not claim the score was updated', async () => {
    open(() => ok({}), empty500);
    await save();
    expect(await screen.findByText(/Could not load the PIS score - try again/)).toBeTruthy();
    await waitFor(() => expect(screen.queryByText(/PIS score updated successfully/)).toBeNull());
    expect(await screen.findByText(/PIS inputs saved\.$/)).toBeTruthy();
  });
  it('a good save reports the updated score', async () => {
    open(() => ok({}));
    await save();
    expect(await screen.findByText(/PIS score updated successfully/)).toBeTruthy();
  });
});
