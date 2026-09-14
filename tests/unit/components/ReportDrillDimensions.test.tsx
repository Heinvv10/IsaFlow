import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AccountDrillDown } from '@/components/accounting/AccountDrillDown';
import { EvidenceDrillModal } from '@/components/accounting/evidence/EvidenceDrillModal';
import { TrialBalanceRow } from '@/components/reports/TrialBalanceRow';
import AccountDetailPage from '@/../pages/accounting/reports/account-detail/[accountId]';
import { apiFetch } from '@/lib/apiFetch';
vi.mock('@/lib/apiFetch', () => ({ apiFetch: vi.fn() }));
vi.mock('@/contexts/TableDensityContext', () => ({ useTableDensity: () => ({ rowClass: '' }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: {children: React.ReactNode}) => <>{children}</> }));
const route = vi.hoisted(() => ({ query: {accountId: '5000', from: '2026-04-01', to: '2026-04-30', cost_centre_id: 'centre-a', business_unit_id: 'bu-a'}, pathname: '/accounting/reports/account-detail/[accountId]', push: vi.fn() }));
vi.mock('next/router', () => ({ useRouter: () => route }));
const dates = {periodStart: '2026-04-01', periodEnd: '2026-04-30'};
const response = (data: unknown, status = 200) => new Response(JSON.stringify({data}), {status});
const requestParams = () => new URL(String(vi.mocked(apiFetch).mock.calls.at(-1)?.[0]), 'http://localhost').searchParams;
const ledger = (description: string) => ({
  rows:[{journalEntryId:description, entryDate:'2026-04-01', entryNumber:'JE-1', description,
    reference:'', source:'manual', debit:1, credit:0, runningBalance:1}],
  total:201, openingBalance:0, periodNet:1, periodClosingBalance:1,
  meta:{accountId:'account-1', accountCode:'5000', accountName:'Expense', accountType:'expense', normalBalance:'debit'},
});
afterEach(cleanup);
beforeEach(() => {
  route.query = {accountId:'5000', from:'2026-04-01', to:'2026-04-30', cost_centre_id:'centre-a', business_unit_id:'bu-a'};
  route.push.mockReset();
  vi.mocked(apiFetch).mockReset();
});

describe('report drill cost centre selection', () => {
  it('offers a BU-scoped full ledger link that returns to the income statement', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => response({transactions: []}));
    const returnTo = '/accounting/reports/income-statement?period_start=2026-01-01&period_end=2026-01-31&business_unit_id=bu-a';
    const drill = render(<AccountDrillDown accountCode="5000" {...dates} businessUnitId="bu-a"
      source="is" returnTo={returnTo} />);
    const link = await screen.findByRole('link', {name:'Open full ledger'});
    const href = new URL(link.getAttribute('href')!, 'http://localhost');
    expect(href.searchParams.get('business_unit_id')).toBe('bu-a');
    expect(href.searchParams.get('source')).toBe('is');
    expect(href.searchParams.get('return_to')).toContain('/accounting/reports/income-statement');
    drill.unmount();

    route.query = {accountId:'5000', ...Object.fromEntries(href.searchParams)};
    vi.mocked(apiFetch).mockImplementation(async () => response(null));
    render(<AccountDetailPage />);
    expect(screen.getByRole('link', {name:'Back to Income Statement'})).toHaveAttribute('href', returnTo);
  });

  it('carries the business unit through transactions, evidence, account links and account detail', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => response({transactions: []}));
    const view = render(<AccountDrillDown accountCode="5000" {...dates} businessUnitId="bu-a" />);
    await screen.findByText('No transactions in this period');
    expect(requestParams().get('business_unit_id')).toBe('bu-a');
    view.unmount();

    vi.mocked(apiFetch).mockClear().mockImplementation(async () => response({rows: [], count: 0}));
    const evidence = render(<EvidenceDrillModal accountId="5000" accountName="Expense" {...dates} businessUnitId="bu-a" onClose={vi.fn()} />);
    await screen.findByText('No journal entries found for this period');
    expect(requestParams().get('business_unit_id')).toBe('bu-a');
    evidence.unmount();

    vi.mocked(apiFetch).mockClear().mockImplementation(async () => response({transactions: []}));
    render(<table><tbody><TrialBalanceRow row={{accountCode:'5000', accountName:'Expense', accountType:'expense', debitBalance:17, creditBalance:0}} isExpanded onToggle={vi.fn()} onEvidence={vi.fn()} showComparative={false} showMovement={false} drillDownStart={dates.periodStart} drillDownEnd={dates.periodEnd} colSpan={6} businessUnitId="bu-a" /></tbody></table>);
    expect(screen.getByRole('link', {name:'Expense'})).toHaveAttribute('href', '/accounting/reports/account-detail/5000?from=2026-04-01&to=2026-04-30&source=tb&business_unit_id=bu-a');
    await waitFor(() => expect(requestParams().get('business_unit_id')).toBe('bu-a'));
    cleanup();

    vi.mocked(apiFetch).mockClear().mockImplementation(async () => response(null));
    render(<AccountDetailPage />);
    await waitFor(() => expect(requestParams().get('business_unit_id')).toBe('bu-a'));
  });

  it('reloads transactions when the centre changes and omits the filter for All', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => response({transactions: []}));
    const view = render(<AccountDrillDown accountCode="5000" {...dates} costCentreId="centre-a" />);
    await screen.findByText('No transactions in this period');
    expect(requestParams().get('cost_centre_id')).toBe('centre-a');
    view.rerender(<AccountDrillDown accountCode="5000" {...dates} costCentreId="centre-b" />);
    await waitFor(() => expect(requestParams().get('cost_centre_id')).toBe('centre-b'));
    view.rerender(<AccountDrillDown accountCode="5000" {...dates} />);
    await waitFor(() => expect(requestParams().has('cost_centre_id')).toBe(false));
  });

  it('reads the evidence rows envelope and reloads for the selected centre', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => response({rows: [{jeId: 'je1', entryNumber: 'JE-100', description: 'Project expense', debit: 17, credit: 0, postingAgent: 'human:tester', extractionConfidence: 0.95, sourceDocumentId: 'doc1', documentVendor: 'Vendor One'}], count: 1}));
    const props = {accountId: '5000', accountName: 'Expense', ...dates, onClose: vi.fn()};
    const view = render(<EvidenceDrillModal {...props} costCentreId="centre-a" />);
    await screen.findByText('Project expense');
    expect(screen.getByText('JE-100')).toBeInTheDocument();
    expect(screen.getByRole('button', {name:'Vendor One'})).toBeInTheDocument();
    expect(requestParams().get('cost_centre_id')).toBe('centre-a');
    view.rerender(<EvidenceDrillModal {...props} costCentreId="centre-b" />);
    await waitFor(() => expect(requestParams().get('cost_centre_id')).toBe('centre-b'));
    view.rerender(<EvidenceDrillModal {...props} />);
    await waitFor(() => expect(requestParams().has('cost_centre_id')).toBe(false));
  });

  it('opens the real journal evidence contract from a source document', async () => {
    vi.mocked(apiFetch).mockImplementation(async url => response(String(url).includes('/je/') ? {je: {extractionConfidence: 0.95}, lines: [{id:'l1', glAccountName:'Materials', debit:17, credit:0}], document: {vendorName:'Actual vendor', referenceNumber:'INV-123'}} : {rows: [{jeId:'je1', entryNumber:'JE-100', debit:17, credit:0, postingAgent:null, extractionConfidence:null, sourceDocumentId:'doc1', documentVendor:'Vendor One'}], count:1}));
    render(<EvidenceDrillModal accountId="5000" accountName="Expense" {...dates} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', {name:'Vendor One'}));
    await screen.findByText('Actual vendor');
    expect(screen.getByText('INV-123')).toBeInTheDocument();
    expect(screen.getByText('Materials')).toBeInTheDocument();
    expect(apiFetch).toHaveBeenLastCalledWith('/api/accounting/evidence/je/je1');
  });

  it('keeps the trial balance centre in both its account link and expanded transactions', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => response({transactions: []}));
    render(<table><tbody><TrialBalanceRow row={{accountCode:'5000', accountName:'Expense', accountType:'expense', debitBalance:17, creditBalance:0}} isExpanded onToggle={vi.fn()} onEvidence={vi.fn()} showComparative={false} showMovement={false} drillDownStart={dates.periodStart} drillDownEnd={dates.periodEnd} colSpan={6} costCentreId="centre-a" /></tbody></table>);
    expect(screen.getByRole('link', {name:'Expense'})).toHaveAttribute('href', '/accounting/reports/account-detail/5000?from=2026-04-01&to=2026-04-30&source=tb&cost_centre_id=centre-a');
    await waitFor(() => expect(requestParams().get('cost_centre_id')).toBe('centre-a'));
  });

  it('consumes the account detail centre query and reloads on centre changes', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => response(null));
    const view = render(<AccountDetailPage />);
    await waitFor(() => expect(requestParams().get('cost_centre_id')).toBe('centre-a'));
    route.query.cost_centre_id = 'centre-b';
    view.rerender(<AccountDetailPage />);
    await waitFor(() => expect(requestParams().get('cost_centre_id')).toBe('centre-b'));
    route.query.cost_centre_id = '';
    view.rerender(<AccountDetailPage />);
    await waitFor(() => expect(requestParams().has('cost_centre_id')).toBe(false));
  });

  it('shows transaction and evidence API failures instead of treating error envelopes as data', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => response({message:'Unavailable'}, 503));
    const drill = render(<AccountDrillDown accountCode="5000" {...dates} />);
    expect(await screen.findByText('Failed to load transactions')).toBeInTheDocument();
    drill.unmount();

    render(<EvidenceDrillModal accountId="5000" accountName="Expense" {...dates} onClose={vi.fn()} />);
    expect(await screen.findByText('Failed to load evidence')).toBeInTheDocument();
    expect(screen.queryByText('No journal entries found for this period')).not.toBeInTheDocument();
  });

  it('ignores evidence from a superseded business-unit request', async () => {
    let resolveA!: (value: Response) => void;
    let resolveB!: (value: Response) => void;
    const requestA = new Promise<Response>(resolve => { resolveA = resolve; });
    const requestB = new Promise<Response>(resolve => { resolveB = resolve; });
    vi.mocked(apiFetch).mockImplementation(async url =>
      new URL(String(url), 'http://localhost').searchParams.get('business_unit_id') === 'bu-a'
        ? requestA : requestB);
    const props = {accountId:'5000', accountName:'Expense', ...dates, onClose:vi.fn()};
    const view = render(<EvidenceDrillModal {...props} businessUnitId="bu-a" />);
    view.rerender(<EvidenceDrillModal {...props} businessUnitId="bu-b" />);

    await act(async () => resolveB(response({rows:[{jeId:'b', description:'BU B row', debit:1, credit:0, postingAgent:null, extractionConfidence:null}], count:1})));
    expect(await screen.findByText('BU B row')).toBeInTheDocument();
    await act(async () => resolveA(response({rows:[{jeId:'a', description:'BU A row', debit:1, credit:0, postingAgent:null, extractionConfidence:null}], count:1})));
    expect(screen.queryByText('BU A row')).not.toBeInTheDocument();
    expect(screen.getByText('BU B row')).toBeInTheDocument();
  });

  it('ignores an older account-ledger business-unit response', async () => {
    let resolveA!: (value: Response) => void;
    let resolveB!: (value: Response) => void;
    const requestA = new Promise<Response>(resolve => { resolveA = resolve; });
    const requestB = new Promise<Response>(resolve => { resolveB = resolve; });
    vi.mocked(apiFetch).mockImplementation(async url =>
      new URL(String(url), 'http://localhost').searchParams.get('business_unit_id') === 'bu-a'
        ? requestA : requestB);
    const view = render(<AccountDetailPage />);
    await waitFor(() => expect(vi.mocked(apiFetch)).toHaveBeenCalledTimes(1));
    route.query = {...route.query, business_unit_id:'bu-b'};
    view.rerender(<AccountDetailPage />);
    await waitFor(() => expect(vi.mocked(apiFetch)).toHaveBeenCalledTimes(2));

    await act(async () => resolveB(response(ledger('BU B ledger'))));
    expect(await screen.findByText('BU B ledger')).toBeInTheDocument();
    await act(async () => resolveA(response(ledger('BU A ledger'))));
    expect(screen.queryByText('BU A ledger')).not.toBeInTheDocument();
  });

  it('ignores an older account-ledger page response', async () => {
    let resolvePage1!: (value: Response) => void;
    let resolvePage2!: (value: Response) => void;
    const page1 = new Promise<Response>(resolve => { resolvePage1 = resolve; });
    const page2 = new Promise<Response>(resolve => { resolvePage2 = resolve; });
    vi.mocked(apiFetch).mockImplementation(async url =>
      new URL(String(url), 'http://localhost').searchParams.get('offset') === '200' ? page2 : page1);
    const view = render(<AccountDetailPage />);
    await waitFor(() => expect(vi.mocked(apiFetch)).toHaveBeenCalledTimes(1));
    route.query = {...route.query, page:'2'} as typeof route.query;
    view.rerender(<AccountDetailPage />);
    await waitFor(() => expect(vi.mocked(apiFetch)).toHaveBeenCalledTimes(2));

    await act(async () => resolvePage2(response(ledger('Page 2 ledger'))));
    expect(await screen.findByText('Page 2 ledger')).toBeInTheDocument();
    await act(async () => resolvePage1(response(ledger('Page 1 ledger'))));
    expect(screen.queryByText('Page 1 ledger')).not.toBeInTheDocument();
  });
});
