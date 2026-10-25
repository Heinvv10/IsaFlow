// D2 round 9 (pages 3/3): SUCCESS renders a field read from the REAL route envelope; an empty 500 shows one sentence and no rows.
//   audit-portal/[sessionId], contact, developer/personal-tokens, payroll/batches/new, payroll/duplicates, payroll/employees/[id].
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { empty500, expectNoJargon, MSG, ok, on, refuse, serve, type Route } from '../helpers/d2R3a6';

const route = vi.hoisted(() => ({ query: {} as Record<string, string>, isReady: true, pathname: '/', push: vi.fn(), replace: vi.fn(), back: vi.fn() }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/router', () => ({ useRouter: () => route }));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
vi.mock('next/head', () => ({ default: () => null }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/landing/LandingNavbar', () => ({ LandingNavbar: () => null }));
vi.mock('@/components/landing/LandingPricingTestimonialsFooter', () => ({ LandingFooter: () => null }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'owner', companyId: 'c1' }) }));

import { apiFetch } from '@/lib/apiFetch';
import AuditPortalPage from '../../../pages/audit-portal/[sessionId]';
import ContactPage from '../../../pages/contact';
import PersonalTokensPage from '../../../pages/developer/personal-tokens';
import NewBatchPage from '../../../pages/payroll/batches/new';
import DuplicatesPage from '../../../pages/payroll/duplicates';
import EmployeeDetailPage from '../../../pages/payroll/employees/[id]';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
beforeEach(() => { vi.mocked(apiFetch).mockReset(); route.query = {}; route.push.mockReset(); });
afterEach(() => { cleanup(); });

describe('audit-portal/[sessionId] (HEAD /api/audit-portal/download: 200 ready, 401 expired, else unavailable)', () => {
  const head = (status: number) => vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status })));
  beforeEach(() => { route.query = { sessionId: 'sess-d2', token: 'tok-d2' }; });
  it('200: offers the PDF download for this session and token', async () => {
    head(200);
    render(<AuditPortalPage />);
    const link = (await screen.findByText(/Download audit pack/)).closest('a') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/api/audit-portal/download?sessionId=sess-d2&token=tok-d2');
  });
  it('401: says the session is invalid or expired, with no download link', async () => {
    head(401);
    render(<AuditPortalPage />);
    expect(await screen.findByText(/Session invalid or expired/)).toBeDefined();
    expect(screen.queryByText(/Download audit pack/)).toBeNull();
  });
  it('500: says the pack is unavailable, with no download link', async () => {
    head(500);
    render(<AuditPortalPage />);
    expect(await screen.findByText('The audit pack is unavailable right now - please try again shortly')).toBeDefined();
    expect(screen.queryByText(/Download audit pack/)).toBeNull();
  });
});

describe('contact (route: POST /api/contact -> { success, data: null } | { success: false, error: { message } })', () => {
  const send = async (res: () => Response) => {
    const fetchMock = vi.fn(async () => res());
    vi.stubGlobal('fetch', fetchMock);
    const { container } = render(<ContactPage />);
    const set = (name: string, value: string) => fireEvent.change(container.querySelector(`[name="${name}"]`) as HTMLInputElement, { target: { value } });
    set('name', 'D2 Sender'); set('email', 'd2@sender.test'); set('company', 'D2 Co'); set('message', 'D2 hello there');
    fireEvent.submit(container.querySelector('form') as HTMLFormElement);
    return fetchMock;
  };
  it('success: posts the four fields and confirms the message was sent', async () => {
    const f = await send(() => ok(null));
    expect(await screen.findByText('Thanks — message sent')).toBeDefined();
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/contact');
    expect(JSON.parse(init.body as string)).toMatchObject({ name: 'D2 Sender', email: 'd2@sender.test', company: 'D2 Co', message: 'D2 hello there' });
  });
  it('a 400 shows the server message; an empty 500 a plain sentence; neither says sent', async () => {
    await send(() => refuse());
    expect(await screen.findByText(MSG)).toBeDefined();
    cleanup();
    await send(empty500);
    expect(await screen.findByText('Could not send your message. Please email accounts@isaflow.co.za.')).toBeDefined();
    expect(screen.queryByText('Thanks — message sent')).toBeNull(); expectNoJargon();
  });
});

describe('developer/personal-tokens (route: GET data = PatItem[])', () => {
  const tok = { id: 't1', name: 'D2 CI Token', prefix: 'pat_d2ab', scopes: ['read:invoices', 'write:journals'], expiresAt: '2099-01-01T00:00:00Z', lastUsedAt: null, createdAt: '2026-09-01T00:00:00Z' };
  it('success: the row shows name, prefix, scopes and Never used', async () => {
    serve(on('GET', 'personal-tokens', () => ok([tok])));
    render(<PersonalTokensPage />);
    const tr = (await screen.findByText('D2 CI Token')).closest('tr') as HTMLElement;
    expect(within(tr).getByText('pat_d2ab…')).toBeDefined();
    expect(within(tr).getByText('read:invoices, write:journals')).toBeDefined();
    expect(within(tr).getByText('Never')).toBeDefined();
  });
  it('an empty 500 says a sentence and lists no tokens', async () => {
    serve(on('GET', 'personal-tokens', empty500));
    render(<PersonalTokensPage />);
    expect(await screen.findByText('Could not load your tokens - try again')).toBeDefined();
    expect(screen.queryByText('D2 CI Token')).toBeNull(); expectNoJargon();
  });
});

describe('payroll/batches/new (routes: components -> Component[], POST batches -> { id })', () => {
  const comp = { id: 'c1', name: 'D2 Bonus', sarsSourceCode: '3605', componentType: 'earning' };
  it('success: offers the component by name and code, then opens the created batch by the returned id', async () => {
    serve(on('GET', 'payroll/components', () => ok([comp])), on('POST', 'payroll/batches', () => ok({ id: 'batch-d2-9' })));
    const { container } = render(<NewBatchPage />);
    expect(await screen.findByRole('option', { name: 'D2 Bonus (3605)' })).toBeDefined();
    fireEvent.change(container.querySelector('select') as HTMLSelectElement, { target: { value: 'c1' } });
    fireEvent.change(screen.getByPlaceholderText('e.g. April overtime'), { target: { value: 'D2 overtime' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Batch' }));
    await waitFor(() => expect(route.push).toHaveBeenCalledWith('/payroll/batches/batch-d2-9'));
    const post = vi.mocked(apiFetch).mock.calls.find(([, i]) => (i as RequestInit | undefined)?.method === 'POST')!;
    expect(JSON.parse((post[1] as RequestInit).body as string)).toMatchObject({ componentId: 'c1', description: 'D2 overtime' });
  });
  it('an empty 500 loading the components says a sentence and offers none', async () => {
    serve(on('GET', 'payroll/components', empty500));
    render(<NewBatchPage />);
    expect(await screen.findByText('Could not load the pay components - try again')).toBeDefined();
    expect(screen.queryByRole('option', { name: /D2 Bonus/ })).toBeNull(); expectNoJargon();
  });
});

describe('payroll/duplicates (route: data = { idNumber, taxNumber, passportNumber, employeeNumber, bankAccount, totals })', () => {
  const dup = { idNumber: [{ value: 'D2-ID-777', employees: [{ id: 'e1', employeeNumber: 'E-77', name: 'D2 Dup Person', status: 'active' }] }],
    taxNumber: [], passportNumber: [], employeeNumber: [], bankAccount: [], totals: { totalConflicts: 1, affectedEmployees: 2 } };
  it('success: shows the totals and the conflicting group with its employees', async () => {
    serve(on('GET', 'payroll/duplicates', () => ok(dup)));
    render(<DuplicatesPage />);
    expect(await screen.findByText('D2-ID-777')).toBeDefined();
    expect(screen.getByText('D2 Dup Person')).toBeDefined();
    expect(screen.getByText('E-77')).toBeDefined();
    expect(document.body.textContent).toContain('1 conflict group(s)');
    expect(document.body.textContent).toContain('2 employee(s) affected');
  });
  it('an empty 500 says a sentence and shows no group', async () => {
    serve(on('GET', 'payroll/duplicates', empty500));
    render(<DuplicatesPage />);
    expect(await screen.findByText('Could not load the duplicates - try again')).toBeDefined();
    expect(screen.queryByText('D2-ID-777')).toBeNull(); expectNoJargon();
  });
});

describe('payroll/employees/[id] (routes: employees/:id -> Employee, payroll/components, employees/:id/components -> Assignment[])', () => {
  const emp = { id: 'e1', employeeNumber: 'E-D2-9', firstName: 'D2First', lastName: 'D2Last', employmentType: 'permanent', startDate: '2020-01-01',
    uifExcluded: false, medicalAidMainMember: false, medicalAidDependantsCount: 0 };
  const asg = { id: 'a1', componentId: 'c1', componentName: 'D2 Bonus Comp', componentType: 'earning', amount: 321, effectiveFrom: '2026-01-01', effectiveTo: null, isRecurring: true };
  const routes = (empRes: () => Response): Route[] => [
    (u, m) => (m === 'GET' && u.endsWith('/api/payroll/employees/e1') ? empRes() : undefined),
    on('GET', 'employees/e1/components', () => ok([asg])),
    on('GET', 'api/payroll/components', () => ok([{ id: 'c1', name: 'D2 Bonus Comp', componentType: 'earning', sarsSourceCode: '3605' }])),
  ];
  beforeEach(() => { route.query = { id: 'e1' }; });
  it('success: the heading names the employee and the assignment list shows the component and amount', async () => {
    serve(...routes(() => ok(emp)));
    render(<EmployeeDetailPage />);
    expect(await screen.findByRole('heading', { name: 'D2First D2Last' })).toBeDefined();
    expect(screen.getByText('E-D2-9')).toBeDefined();
    const tr = screen.getAllByText('D2 Bonus Comp').map((n) => n.closest('tr')).find(Boolean) as HTMLElement;
    expect(tr.textContent).toMatch(/321\.00/);
  });
  it('an empty 500 says a sentence and shows no employee', async () => {
    serve(...routes(empty500));
    render(<EmployeeDetailPage />);
    expect(await screen.findByText('Could not load this employee - try again')).toBeDefined();
    expect(screen.queryByText('E-D2-9')).toBeNull(); expectNoJargon();
  });
});
