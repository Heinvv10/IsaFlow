import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
const response = (data: unknown) => new Response(JSON.stringify({data}));
const requestParams = () => new URL(String(vi.mocked(apiFetch).mock.calls.at(-1)?.[0]), 'http://localhost').searchParams;
afterEach(cleanup);
beforeEach(() => vi.mocked(apiFetch).mockReset());

describe('report drill cost centre selection', () => {
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
});
