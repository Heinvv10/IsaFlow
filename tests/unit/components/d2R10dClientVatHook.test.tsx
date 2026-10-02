// D2 round 10 (d): practice/clients/[id], VatSummaryWidget, useBalanceSheetFilters. Real route envelopes:
//   practice/clients/:id -> data PracticeClient (404 -> notFound); practice/client-contacts -> data ClientContact[];
//   reports-vat-return -> data { outputVAT, inputVAT, netVAT, ... }; fiscal-periods?open_period=true -> data FiscalPeriod (camelCase endDate).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { MSG, empty500, expectNoJargon, ok, on, refuse, serve } from '../helpers/d2R3a6';

const route = vi.hoisted(() => ({ query: {} as Record<string, string>, isReady: true, pathname: '/', push: vi.fn(async () => true), replace: vi.fn() }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/router', () => ({ useRouter: () => route }));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'owner', companyId: 'c1' }) }));
vi.mock('@/components/practice/ClientRateOverrides', () => ({ ClientRateOverrides: () => null }));

import { apiFetch } from '@/lib/apiFetch';
import { localISODate } from '@/lib/dateUtils';
import ClientPage from '../../../pages/accounting/practice/clients/[id]';
import { VatSummaryWidget } from '../../../src/components/dashboard/widgets/VatSummaryWidget';
import { useBalanceSheetFilters } from '../../../src/components/reports/useBalanceSheetFilters';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
beforeEach(() => { vi.mocked(apiFetch).mockReset(); route.query = {}; route.isReady = true; });
afterEach(() => { cleanup(); });
const money = (digits: string) => new RegExp(digits.replace(' ', '[\\s\\u00a0\\u202f]'));

describe('practice/clients/[id] (load only; the page has no write action)', () => {
  const UUID = '11111111-1111-4111-8111-111111111111';
  const client = { id: UUID, legalName: 'D2 Legal Pty Ltd', tradingName: 'D2 Trading As', registrationNo: '2020/123456/07', taxNo: '9876543210',
    billingModel: 'retainer', status: 'active', clientGroupId: null };
  const contact = { id: 'ct1', name: 'D2 Contact Person', email: 'd2-contact@x.test', phone: '082 000 0000', role: 'Director', isPrimary: true };
  beforeEach(() => { route.query = { id: UUID }; });
  const base = (clientAnswer: () => Response, contactsAnswer: () => Response = () => ok([contact])) =>
    serve(on('GET', 'practice/client-contacts', contactsAnswer), on('GET', 'practice/clients/', clientAnswer));
  it('success: shows the legal and trading name, registration and tax numbers; the contacts tab lists the served contact', async () => {
    base(() => ok(client));
    render(<ClientPage />);
    expect((await screen.findAllByText('D2 Legal Pty Ltd')).length).toBeGreaterThan(0);
    expect(screen.getByText('D2 Trading As')).toBeDefined();
    expect(screen.getByText('2020/123456/07')).toBeDefined();
    expect(screen.getByText('9876543210')).toBeDefined();
    expect(screen.getByText('Retainer')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: /Contacts/ }));
    const row = screen.getByText('D2 Contact Person').closest('tr') as HTMLElement;
    expect(within(row).getByText('d2-contact@x.test')).toBeDefined();
    expect(within(row).getByText('Director')).toBeDefined();
    expect(within(row).getByText('Primary')).toBeDefined();
  });
  it('a 400 refusal shows the server message and no client', async () => {
    base(() => refuse());
    render(<ClientPage />);
    expect(await screen.findByText(MSG)).toBeDefined();
    expect(screen.queryByText('D2 Legal Pty Ltd')).toBeNull();
  });
  it('an empty 500 shows the sentence and no client', async () => {
    base(empty500);
    render(<ClientPage />);
    expect(await screen.findByText('Could not load the client - try again')).toBeDefined();
    expect(screen.queryByText('D2 Legal Pty Ltd')).toBeNull(); expectNoJargon();
  });
  it('a 404 says the client was not found', async () => {
    base(() => new Response(JSON.stringify({ success: false, error: { code: 'NOT_FOUND', message: 'Client not found' } }), { status: 404 }));
    render(<ClientPage />);
    expect(await screen.findByText('Client not found')).toBeDefined();
  });
  it('a refused contacts list keeps the client and shows the server message on the contacts tab', async () => {
    base(() => ok(client), () => refuse());
    render(<ClientPage />);
    await screen.findByText('2020/123456/07');
    fireEvent.click(screen.getByRole('button', { name: /Contacts/ }));
    expect(await screen.findByText(MSG)).toBeDefined();
  });
  it('an empty 500 on the contacts list shows a sentence on the contacts tab and keeps the client', async () => {
    base(() => ok(client), empty500);
    render(<ClientPage />);
    await screen.findByText('2020/123456/07');
    fireEvent.click(screen.getByRole('button', { name: /Contacts/ }));
    expect(await screen.findByText('Could not load the contacts - try again')).toBeDefined(); expectNoJargon();
  });
});

describe('VatSummaryWidget (route data: full-caps outputVAT / inputVAT / netVAT)', () => {
  it('success: shows output, input and net payable from the served fields', async () => {
    serve(on('GET', 'reports-vat-return', () => ok({ outputVAT: 1234.5, inputVAT: 321.25, netVAT: 913.25 })));
    render(<VatSummaryWidget />);
    expect(await screen.findByText(money('R 1 234,50'))).toBeDefined();
    expect(screen.getByText(money('R 321,25'))).toBeDefined();
    expect(screen.getByText(money('R 913,25'))).toBeDefined();
    expect(screen.getByText('Net VAT Payable')).toBeDefined();
  });
  it('a negative net is shown as a refund due, as an absolute amount', async () => {
    serve(on('GET', 'reports-vat-return', () => ok({ outputVAT: 100, inputVAT: 777, netVAT: -677 })));
    render(<VatSummaryWidget />);
    expect(await screen.findByText('VAT Refund Due')).toBeDefined();
    expect(screen.getByText(money('R 677,00'))).toBeDefined();
  });
  it('a 400 refusal and an empty 500 each show the widget sentence, no figures, no jargon', async () => {
    serve(on('GET', 'reports-vat-return', () => refuse()));
    render(<VatSummaryWidget />);
    expect(await screen.findByText('Unable to load VAT data')).toBeDefined();
    cleanup();
    serve(on('GET', 'reports-vat-return', empty500));
    render(<VatSummaryWidget />);
    expect(await screen.findByText('Unable to load VAT data')).toBeDefined();
    expect(screen.queryByText('Net VAT Payable')).toBeNull(); expectNoJargon();
  });
});

describe('useBalanceSheetFilters (no error surface by design: a failed period lookup falls back to today)', () => {
  const today = localISODate();
  const wait = async (r: { current: ReturnType<typeof useBalanceSheetFilters> }) => { await waitFor(() => expect(r.current.periodResolved).toBe(true)); return r.current; };
  it('success: as-at date is the open period end when that is before today', async () => {
    serve(on('GET', 'fiscal-periods', () => ok({ id: 'fp1', endDate: '2020-03-31' })));
    const { result } = renderHook(() => useBalanceSheetFilters());
    expect((await wait(result)).asAtDate).toBe('2020-03-31');
  });
  it('success: an open period ending after today is capped to today', async () => {
    serve(on('GET', 'fiscal-periods', () => ok({ id: 'fp1', endDate: '2999-12-31' })));
    const { result } = renderHook(() => useBalanceSheetFilters());
    expect((await wait(result)).asAtDate).toBe(today);
  });
  it('a 400 refusal, an empty 500 and a 404 all resolve to today instead of hanging', async () => {
    for (const answer of [() => refuse(), empty500, () => refuse('No open fiscal period found', 404)]) {
      cleanup(); vi.mocked(apiFetch).mockReset();
      serve(on('GET', 'fiscal-periods', answer));
      const { result } = renderHook(() => useBalanceSheetFilters());
      expect((await wait(result)).asAtDate).toBe(today);
    }
  });
  it('the URL filters (as_at_date, cost centre, business unit) are used as given and no period lookup is made', async () => {
    route.query = { as_at_date: '2024-02-29', cost_centre_id: 'cc-d2', business_unit_id: 'bu-d2' };
    serve(on('GET', 'fiscal-periods', () => ok({ id: 'fp1', endDate: '2020-03-31' })));
    const { result } = renderHook(() => useBalanceSheetFilters());
    const r = await wait(result);
    expect([r.asAtDate, r.costCentreId, r.businessUnitId]).toEqual(['2024-02-29', 'cc-d2', 'bu-d2']);
    expect(vi.mocked(apiFetch)).not.toHaveBeenCalled();
  });
});
