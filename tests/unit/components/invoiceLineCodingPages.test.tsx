// The REAL new and edit customer-invoice pages with the shared line table (migration 870): the account picker
// offers only active LEAF revenue accounts; Dimensions offers projects that are not cancelled and ACTIVE cost centres
// (fetched with ?active=true); each picker writes its own field; the header Project is display only and pre-fills
// new lines; an edit round-trips what each line and the header are coded to, labelling a project past the list's cap
// by fetching it by id, and telling loading, failed and unavailable apart; the approver sees each line's coding.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

const router = vi.hoisted(() => ({ query: {} as Record<string, string>, pathname: '/x', push: vi.fn(async () => true) }));
vi.mock('next/router', () => ({ useRouter: () => router }));
vi.mock('next/link', () => ({ default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/accounting/ScanAndFillButton', () => ({ ScanAndFillButton: () => null }));

import NewCustomerInvoicePage from '../../../pages/accounting/customer-invoices/new';
import EditCustomerInvoicePage from '../../../pages/accounting/customer-invoices/edit/[invoiceId]';
import { lineCoding } from '@/components/invoices/CustomerInvoiceSummary';
import { CodingPicker } from '@/components/accounting/customer-invoices/InvoiceLineItemsTable';

const ACC = { commercials: 'a1000000-0000-4000-8000-000000000001', header: 'a1000000-0000-4000-8000-000000000002',
  child: 'a1000000-0000-4000-8000-000000000003', retired: 'a1000000-0000-4000-8000-000000000004',
  crew: 'a1000000-0000-4000-8000-000000000005' };
const P1 = 'b1000000-0000-4000-8000-000000000001';
const FAR = 'b1000000-0000-4000-8000-000000000250'; // past the 200-row project list
const CC1 = 'c1000000-0000-4000-8000-000000000001';
const account = (id: string, code: string, name: string, extra: Record<string, unknown> = {}) =>
  ({ id, accountCode: code, accountName: name, accountType: 'revenue', isActive: true, ...extra });

const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
let sent: { url: string; body: Record<string, unknown> }[] = [];
let gets: string[] = [];

function serve(invoice?: Record<string, unknown>, opts: { failLists?: boolean } = {}) {
  sent = []; gets = [];
  vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    if (init?.method === 'POST' || init?.method === 'PUT') {
      sent.push({ url: u, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      return ok({ id: 'inv-1' });
    }
    gets.push(u);
    if (opts.failLists && u.includes('chart-of-accounts')) return new Response(JSON.stringify({ success: false }), { status: 500 });
    if (u.includes('chart-of-accounts')) {
      return ok([
        account(ACC.commercials, '4100', 'Commercials'), account(ACC.header, '4300', 'Studio header'),
        account(ACC.child, '4310', 'Studio child', { parentAccountId: ACC.header }),
        account(ACC.retired, '4400', 'Retired', { isActive: false }), account(ACC.crew, '6100', 'Crew', { accountType: 'expense' }),
      ]);
    }
    if (u.includes('/projects?ids=')) return ok([{ id: FAR, project_number: 'P250', name: 'Long-running series', status: 'active' }]);
    if (u.includes('/projects')) {
      return ok([{ id: P1, project_number: 'P1', name: 'Shoot', status: 'active' },
        { id: 'b1000000-0000-4000-8000-000000000003', project_number: 'P3', name: 'Dead', status: 'cancelled' }]);
    }
    if (u.includes('cost-centres')) return ok({ items: [{ id: CC1, code: 'CC1', name: 'Studio' }] });
    if (u.includes('customer-invoices-detail')) return ok(invoice);
    if (u.includes('/customers')) return ok([{ id: 'cust-1', name: 'Acme' }]);
    return ok([]);
  }));
}
afterEach(() => { vi.unstubAllGlobals(); router.query = {}; });

const optionTexts = (select: HTMLElement) => Array.from(select.querySelectorAll('option')).map((o) => o.textContent);
const dimensions = () => screen.getByRole('button', { name: /Dimensions/ });

async function fillNewInvoice() {
  await waitFor(() => expect(optionTexts(screen.getByLabelText('Revenue account'))).toContain('4100 Commercials'));
  await waitFor(() => expect(screen.getAllByRole('option', { name: 'Acme' }).length).toBe(1));
  fireEvent.change(screen.getByDisplayValue('Select client…'), { target: { value: 'cust-1' } });
  fireEvent.change(screen.getAllByLabelText('Description')[0]!, { target: { value: 'TV spot' } });
  fireEvent.change(screen.getAllByLabelText('Unit price')[0]!, { target: { value: '1000' } });
}

describe('customer invoice line coding — new invoice', () => {
  it('offers only active leaf revenue accounts, live projects and active cost centres', async () => {
    serve();
    render(<NewCustomerInvoicePage />);
    const picker = await screen.findByLabelText('Revenue account');
    await waitFor(() => expect(optionTexts(picker)).toEqual(['Default sales', '4100 Commercials', '4310 Studio child']));
    expect(screen.queryByLabelText('Project')).toBeNull();
    expect(dimensions().getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(dimensions());
    expect(dimensions().getAttribute('aria-expanded')).toBe('true');
    expect(optionTexts(screen.getByLabelText('Project'))).toEqual(['No project', 'P1 Shoot']);
    expect(optionTexts(screen.getByLabelText('Cost centre'))).toEqual(['No cost centre', 'CC1 Studio']);
    expect(gets).toContain('/api/accounting/cost-centres?active=true');
  });

  it('sends each picker\'s own field, and the header project — which pre-fills a line added after it', async () => {
    serve();
    render(<NewCustomerInvoicePage />);
    await fillNewInvoice();
    fireEvent.change(screen.getByLabelText('Revenue account'), { target: { value: ACC.commercials } });
    fireEvent.click(dimensions());
    fireEvent.change(screen.getByLabelText('Cost centre'), { target: { value: CC1 } });
    fireEvent.change(screen.getByLabelText('Invoice project'), { target: { value: P1 } });
    fireEvent.click(screen.getByRole('button', { name: /Add Line/ }));
    expect((screen.getAllByLabelText('Project')[1] as HTMLSelectElement).value).toBe(P1);
    expect((screen.getAllByLabelText('Project')[0] as HTMLSelectElement).value).toBe(''); // existing lines untouched
    fireEvent.change(screen.getAllByLabelText('Description')[1]!, { target: { value: 'Edit' } });
    fireEvent.change(screen.getAllByLabelText('Unit price')[1]!, { target: { value: '200' } });
    fireEvent.click(screen.getByRole('button', { name: /Create Invoice/ }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.body.projectId).toBe(P1);
    expect(sent[0]!.body.items).toMatchObject([
      { glAccountId: ACC.commercials, projectId: '', costCenterId: CC1 },
      { glAccountId: '', projectId: P1, costCenterId: '' },
    ]);
  });

  it('says the options failed to load, rather than "unavailable"', async () => {
    serve(undefined, { failLists: true });
    render(<NewCustomerInvoicePage />);
    expect(await screen.findByText(/Could not load the revenue accounts/)).toBeTruthy();
  });
});

describe('customer invoice line coding — edit', () => {
  const invoice = (items: Record<string, unknown>[], projectId: string | null = null) => ({
    id: 'inv-1', status: 'draft', invoice_number: 'INV-1', client_id: 'cust-1', invoice_date: '2026-07-15',
    tax_rate: 15, currency_code: 'ZAR', project_id: projectId, items,
  });
  const item = (extra: Record<string, unknown>) =>
    ({ description: 'Spot', quantity: 1, unit_price: 100, amount: 100, gl_account_id: null, project_id: null, cost_center_id: null, ...extra });

  it('round-trips the header project and each line\'s coding, labelling a project past the list by id', async () => {
    router.query = { invoiceId: 'inv-1' };
    serve(invoice([item({ gl_account_id: ACC.commercials, project_id: FAR, cost_center_id: CC1 }),
      item({ description: 'Old', gl_account_id: ACC.retired })], FAR));
    render(<EditCustomerInvoicePage />);
    const pickers = await screen.findAllByLabelText('Revenue account');
    await waitFor(() => expect((pickers[0] as HTMLSelectElement).value).toBe(ACC.commercials));
    const lineProject = screen.getAllByLabelText('Project')[0] as HTMLSelectElement; // Dimensions open: a line carries one
    await waitFor(() => expect(lineProject.selectedOptions[0]!.textContent).toBe('P250 Long-running series'));
    expect(gets.some((u) => u.includes(`/projects?ids=${FAR}`))).toBe(true);
    expect((screen.getByLabelText('Invoice project') as HTMLSelectElement).value).toBe(FAR);
    expect((pickers[1] as HTMLSelectElement).selectedOptions[0]!.textContent).toBe('Unavailable — choose another');
    fireEvent.click(screen.getByRole('button', { name: /Save Changes/ }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.body.projectId).toBe(FAR);
    expect(sent[0]!.body.items).toMatchObject([
      { glAccountId: ACC.commercials, projectId: FAR, costCenterId: CC1 },
      { glAccountId: ACC.retired, projectId: null, costCenterId: null },
    ]);
  });
});

describe('the approver sees what each line posts to', () => {
  it('names the account, project and cost centre, or the default sales account', () => {
    const base = { id: 'i', description: 'x', quantity: 1, unit_price: 1, amount: 1, tax_rate: 15 };
    expect(lineCoding({ ...base, gl_account_code: '4100', gl_account_name: 'Commercials', project_number: 'P1',
      line_project_name: 'Shoot', cost_center_code: 'CC1', cost_center_name: 'Studio' }))
      .toBe('Revenue: 4100 Commercials · Project: P1 Shoot · Cost centre: CC1 Studio');
    expect(lineCoding(base)).toBe('Revenue: default sales account');
  });
});

describe('a stored id the list does not offer', () => {
  const all = (status: 'loading' | 'ready' | 'failed', known: Record<string, string> = {}) =>
    ({ accounts: [], projects: [], centres: [], known, status, error: '' });
  const label = (status: 'loading' | 'ready' | 'failed', known?: Record<string, string>) => {
    const { container, unmount } = render(<CodingPicker label="P" value={FAR} options={[]} all={all(status, known)} empty="None" onChange={() => undefined} />);
    const text = (container.querySelector('select') as HTMLSelectElement).selectedOptions[0]!.textContent;
    unmount();
    return text;
  };
  it('reads loading, failed, unavailable — or its own name when known — and stays selected', () => {
    expect(label('loading')).toBe('Loading…');
    expect(label('failed')).toBe('Could not load the list — kept as saved');
    expect(label('ready')).toBe('Unavailable — choose another');
    expect(label('ready', { [FAR]: 'P250 Long-running series (cancelled)' })).toBe('P250 Long-running series (cancelled)');
  });
});
