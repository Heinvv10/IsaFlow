// D2 round 9 (pages 2/3): SUCCESS renders a field read from the REAL route envelope; an empty 500 shows one sentence and no rows.
//   suppliers/[supplierId]/rules, suppliers/expectations, suppliers/new, suppliers/rules/index, admin/billing/flow-bundles, admin/trials.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { empty500, expectNoJargon, ok, on, serve } from '../helpers/d2R3a6';

const route = vi.hoisted(() => ({ query: {} as Record<string, string>, isReady: true, pathname: '/', push: vi.fn(), replace: vi.fn() }));
const notify = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/router', () => ({ useRouter: () => route }));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
vi.mock('@/utils/toast', () => ({ notify }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/admin/AdminLayout', () => ({ AdminLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'owner', companyId: 'c1' }) }));

import { apiFetch } from '@/lib/apiFetch';
import SupplierRulesPage from '../../../pages/accounting/suppliers/[supplierId]/rules';
import ExpectationsPage from '../../../pages/accounting/suppliers/expectations';
import NewSupplierPage from '../../../pages/accounting/suppliers/new';
import RulesIndexPage from '../../../pages/accounting/suppliers/rules/index';
import FlowBundlesPage from '../../../pages/admin/billing/flow-bundles';
import AdminTrialsPage from '../../../pages/admin/trials';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
beforeEach(() => { vi.mocked(apiFetch).mockReset(); route.query = {}; route.push.mockReset(); notify.error.mockReset(); notify.success.mockReset(); });
afterEach(() => { cleanup(); });

describe('suppliers/[supplierId]/rules (routes: suppliers-list?id= -> supplier, supplier-rules/:id -> rule, chart-of-accounts -> GLAccount[] (camelCase), cost-centres -> { items })', () => {
  const supplier = { id: 's1', name: 'D2 Rule Supplier' };
  const rule = { id: 'r1', companyId: 'c1', supplierId: 's1', defaultGlAccountId: 'g1', defaultVatCode: 'ZERO_RATED', defaultCostCentreId: null, defaultProjectId: null,
    autoPublish: false, autoPublishMaxAmount: null, autoPublishMinConfidence: 0.8, requirePoMatch: false, qtyTolerancePct: 2, priceTolerancePct: 2,
    learnedSampleCount: 14, learnedFromLastCorrectionAt: null, updatedBy: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z' };
  const gl = { id: 'g1', accountCode: '6100', accountName: 'D2 Stationery', accountType: 'expense', isActive: true };
  const serveAll = (glRows: unknown[], ccBody: unknown) => {
    route.query = { supplierId: 's1' };
    serve(on('GET', 'suppliers-list', () => ok(supplier)), on('GET', 'supplier-rules/s1', () => ok(rule)),
      on('GET', 'chart-of-accounts', () => ok(glRows)), on('GET', 'cost-centres', () => ok(ccBody)));
  };
  it('success: shows the supplier name and the rule\'s learned sample count', async () => {
    serveAll([], { items: [] });
    render(<SupplierRulesPage />);
    expect(await screen.findByText('Coding Rules')).toBeDefined();
    expect(screen.getAllByText('D2 Rule Supplier').length).toBeGreaterThan(0);
    expect(screen.getByText('14')).toBeDefined();   // rule.learnedSampleCount
  });
  it('REAL chart-of-accounts shape: the account dropdown names each account by its code and name', async () => {
    serveAll([gl], { items: [] });
    render(<SupplierRulesPage />);
    expect(await screen.findByRole('option', { name: '6100 D2 Stationery' })).toBeDefined();
  });
  it('REAL cost-centres shape ({ items }): the cost centre dropdown is offered', async () => {
    serveAll([gl], { items: [{ id: 'cc1', code: 'CC9', name: 'D2 Centre' }] });
    render(<SupplierRulesPage />);
    expect(await screen.findByRole('option', { name: 'CC9 D2 Centre' })).toBeDefined();
  });
  it('an empty 500 on the supplier shows a sentence and no rule form', async () => {
    route.query = { supplierId: 's1' };
    serve(on('GET', 'suppliers-list', empty500));
    render(<SupplierRulesPage />);
    expect(await screen.findByText('Could not load the supplier - try again')).toBeDefined();
    expect(screen.queryByText('Coding Rules')).toBeNull(); expectNoJargon();
  });
});

describe('suppliers/expectations (route: data = SupplierExpectation[])', () => {
  const exp = { id: 'e1', companyId: 'c1', supplierId: 's1', cadence: 'monthly', expectedDayOfMonth: 15, expectedAmount: 123.45, amountStddev: null,
    lastInvoiceDate: '2026-09-15', lastInvoiceAmount: 120, sampleSize: 6, status: 'locked', lastRecomputedAt: null, supplierName: 'D2 Landlord' };
  it('success: the row shows supplier, cadence, expected amount, samples and status', async () => {
    serve(on('GET', 'supplier-expectations', () => ok([exp])));
    render(<ExpectationsPage />);
    const tr = (await screen.findByText('D2 Landlord')).closest('tr') as HTMLElement;
    expect(within(tr).getByText('monthly')).toBeDefined();
    expect(within(tr).getByText('locked')).toBeDefined();
    expect(tr.textContent).toMatch(/123\.45/);
    expect(within(tr).getByText('6')).toBeDefined();
  });
  it('an empty 500 shows a sentence and no rows', async () => {
    serve(on('GET', 'supplier-expectations', empty500));
    render(<ExpectationsPage />);
    expect(await screen.findByText('Could not load supplier expectations - try again')).toBeDefined();
    expect(screen.queryByText('D2 Landlord')).toBeNull(); expectNoJargon();
  });
});

describe('suppliers/new (route: POST data = the created supplier row)', () => {
  const submit = async () => {
    render(<NewSupplierPage />);
    fireEvent.change(screen.getByPlaceholderText('e.g. ABC Supplies (Pty) Ltd'), { target: { value: 'D2 New Supplier' } });
    fireEvent.click(screen.getByRole('button', { name: /Save Supplier/ }));
  };
  it('success: posts the name, tells the person, and opens the new supplier by the returned id', async () => {
    serve(on('POST', 'suppliers-list', () => ok({ id: 's-new-9', name: 'D2 New Supplier' })));
    await submit();
    await waitFor(() => expect(route.push).toHaveBeenCalledWith('/accounting/suppliers/s-new-9'));
    expect(notify.success).toHaveBeenCalledWith('Supplier created successfully');
    const post = vi.mocked(apiFetch).mock.calls.find(([, i]) => (i as RequestInit | undefined)?.method === 'POST')!;
    expect(JSON.parse((post[1] as RequestInit).body as string).name).toBe('D2 New Supplier');
  });
  it('an empty 500 says a sentence and goes nowhere', async () => {
    serve(on('POST', 'suppliers-list', empty500));
    await submit();
    await waitFor(() => expect(notify.error).toHaveBeenCalledWith('Could not create the supplier - try again'));
    expect(route.push).not.toHaveBeenCalled(); expect(notify.success).not.toHaveBeenCalled();
  });
});

describe('suppliers/rules/index (route: data = SupplierRule[] with supplierName / defaultGlAccountName)', () => {
  const r = { id: 'r1', supplierId: 's1', supplierName: 'D2 Rules Supplier', defaultGlAccountId: 'g1', defaultGlAccountName: 'D2 Stationery', defaultVatCode: 'ZERO_RATED',
    autoPublish: true, autoPublishMaxAmount: 777, autoPublishMinConfidence: 0.85, learnedSampleCount: 9, updatedAt: '2026-09-02T00:00:00Z' };
  it('success: the row shows supplier, account, VAT badge, max amount, confidence and samples', async () => {
    serve(on('GET', 'supplier-rules', () => ok([r])));
    render(<RulesIndexPage />);
    const tr = (await screen.findByText('D2 Rules Supplier')).closest('tr') as HTMLElement;
    expect(within(tr).getByText('D2 Stationery')).toBeDefined();
    expect(within(tr).getByText('Zero')).toBeDefined();
    expect(tr.textContent).toMatch(/777\.00/);
    expect(within(tr).getByText('85%')).toBeDefined();
    expect(within(tr).getByText('9')).toBeDefined();
  });
  it('an empty 500 shows a sentence and no rows', async () => {
    serve(on('GET', 'supplier-rules', empty500));
    render(<RulesIndexPage />);
    expect(await screen.findByText('Could not load the supplier rules - try again')).toBeDefined();
    expect(screen.queryByText('D2 Rules Supplier')).toBeNull(); expectNoJargon();
  });
});

describe('admin/billing/flow-bundles (route: data = { bundles })', () => {
  const b = { id: 'b1', name: 'D2 Micro Bundle', flows: 100, priceCents: 4900, isActive: true, displayOrder: 3 };
  it('success: the row shows name, flows, price, price per flow and Deactivate', async () => {
    serve(on('GET', 'flow-bundles', () => ok({ bundles: [b] })));
    render(<FlowBundlesPage />);
    const tr = (await screen.findByText('D2 Micro Bundle')).closest('tr') as HTMLElement;
    expect(within(tr).getByText('100')).toBeDefined();
    expect(tr.textContent).toMatch(/49\.00/);   // priceCents / 100
    expect(tr.textContent).toMatch(/0\.49/);    // priceCents / flows / 100
    expect(within(tr).getByText('Deactivate')).toBeDefined();
  });
  it('an empty 500 shows a sentence and no bundles', async () => {
    serve(on('GET', 'flow-bundles', empty500));
    render(<FlowBundlesPage />);
    expect(await screen.findByText('Could not load bundles - try again')).toBeDefined();
    expect(screen.queryByText('D2 Micro Bundle')).toBeNull(); expectNoJargon();
  });
});

describe('admin/trials (routes: trials -> TrialCompany[], trials/stats -> TrialStats)', () => {
  const t = { id: 't1', name: 'D2 Trial Co', plan_name: 'D2 Growth', trial_ends_at: '2026-10-20T00:00:00Z', trial_started_at: null, user_count: 4, status: 'trial', days_left: 3 };
  const stats = { total_trials: 41, expiring_this_week: 8, expired_unpaid: 9, converted_this_month: 7, conversion_rate_percent: 23 };
  it('success: the trial row and the stat cards come from the responses', async () => {
    serve(on('GET', 'trials/stats', () => ok(stats)), on('GET', 'api/admin/trials', () => ok([t])));
    render(<AdminTrialsPage />);
    const tr = (await screen.findByText('D2 Trial Co')).closest('tr') as HTMLElement;
    expect(tr.textContent).toContain('D2 Growth');
    expect(within(tr).getByText('3d left')).toBeDefined();
    expect((await screen.findByText('Total Trials')).closest('div.rounded-xl')!.textContent).toContain('41');
    expect(screen.getByText('Conversion Rate').closest('div.rounded-xl')!.textContent).toContain('23%');
  });
  it('an empty 500 on the list shows a sentence and no trial rows', async () => {
    serve(on('GET', 'trials/stats', () => ok(stats)), on('GET', 'api/admin/trials', empty500));
    render(<AdminTrialsPage />);
    expect(await screen.findByText('Could not load the trials - try again')).toBeDefined();
    expect(screen.queryByText('D2 Trial Co')).toBeNull(); expectNoJargon();
  });
});
