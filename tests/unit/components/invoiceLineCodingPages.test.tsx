// The REAL new and edit customer-invoice pages with the shared line table (migration 874): the account picker
// offers only active LEAF revenue accounts; Dimensions offers jobs that are not cancelled, ACTIVE CC2 projects and
// business units (fetched with ?active=true) — the job and the CC2 project labelled apart; each picker writes its own
// field; the header Job is display only and pre-fills new lines; the edit page edits a line's CC2 / BU and re-sends
// its CC1 only while its CC2 is the one it loaded with (CC1 follows CC2); an edit round-trips what each line and the header are coded to, labelling a project past the list's cap
// by fetching it by id, and telling loading, failed and unavailable apart; the approver sees each line's coding.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

const router = vi.hoisted(() => ({ query: {} as Record<string, string>, pathname: '/x', push: vi.fn(async () => true) }));
vi.mock('next/router', () => ({ useRouter: () => router }));
vi.mock('next/link', () => ({ default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
// Stands in for a scan: one click hands the page an extraction with two lines.
vi.mock('@/components/accounting/ScanAndFillButton', () => ({
  ScanAndFillButton: ({ onExtracted }: { onExtracted: (d: unknown) => void }) => (
    <button type="button" onClick={() => onExtracted({ date: null, dueDate: null, vatRate: null, customerName: null, confidence: 0.9,
      lineItems: [{ description: 'Scanned A', quantity: 1, unitPrice: 10 }, { description: 'Scanned B', quantity: 1, unitPrice: 20 }] })}>
      Scan
    </button>
  ),
}));

import NewCustomerInvoicePage from '../../../pages/accounting/customer-invoices/new';
import EditCustomerInvoicePage from '../../../pages/accounting/customer-invoices/edit/[invoiceId]';
import { lineCoding } from '@/components/invoices/CustomerInvoiceSummary';
import { CodingPicker } from '@/components/accounting/customer-invoices/InvoiceLineItemsTable';

const ACC = { commercials: 'a1000000-0000-4000-8000-000000000001', header: 'a1000000-0000-4000-8000-000000000002',
  child: 'a1000000-0000-4000-8000-000000000003', retired: 'a1000000-0000-4000-8000-000000000004',
  crew: 'a1000000-0000-4000-8000-000000000005' };
const P1 = 'b1000000-0000-4000-8000-000000000001';
const FAR = 'b1000000-0000-4000-8000-000000000250'; // past the 200-row project list
const CC2 = 'c1000000-0000-4000-8000-000000000001';
const BU = 'd1000000-0000-4000-8000-000000000001';
const account = (id: string, code: string, name: string, extra: Record<string, unknown> = {}) =>
  ({ id, accountCode: code, accountName: name, accountType: 'revenue', isActive: true, ...extra });

const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
let sent: { url: string; body: Record<string, unknown> }[] = [];
let gets: string[] = [];

function serve(invoice?: Record<string, unknown>, opts: { failLists?: boolean; failIdsOnce?: boolean } = {}) {
  let idsFailures = opts.failIdsOnce ? 1 : 0;
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
    if (u.includes('/projects?ids=') && idsFailures > 0) { idsFailures -= 1; return new Response('{}', { status: 500 }); }
    if (u.includes('/projects?ids=')) return ok([{ id: FAR, project_number: 'P250', name: 'Long-running series', status: 'active' }]);
    if (u.includes('/projects')) {
      return ok([{ id: P1, project_number: 'P1', name: 'Shoot', status: 'active' },
        { id: 'b1000000-0000-4000-8000-000000000003', project_number: 'P3', name: 'Dead', status: 'cancelled' }]);
    }
    if (u.includes('cost-centres')) return ok({ items: [{ id: CC2, code: 'LAW', name: 'Lawley' }] });
    if (u.includes('business-units')) return ok({ items: [{ id: BU, code: 'ACT', name: 'Activations' }] });
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
  it('offers only active leaf revenue accounts, live jobs, active CC2 projects and BUs', async () => {
    serve();
    render(<NewCustomerInvoicePage />);
    const picker = await screen.findByLabelText('Revenue account');
    await waitFor(() => expect(optionTexts(picker)).toEqual(['Default sales', '4100 Commercials', '4310 Studio child']));
    expect(screen.queryByLabelText('Job (Project Profitability)')).toBeNull();
    expect(dimensions().getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(dimensions());
    expect(dimensions().getAttribute('aria-expanded')).toBe('true');
    expect(optionTexts(screen.getByLabelText('Job (Project Profitability)'))).toEqual(['No job', 'P1 Shoot']);
    expect(optionTexts(screen.getByLabelText('CC2 project'))).toEqual(['No CC2 project', 'LAW Lawley']);
    expect(optionTexts(screen.getByLabelText('BU'))).toEqual(['No BU', 'ACT Activations']);
    expect(gets).toContain('/api/accounting/cost-centres?active=true&cc_type=cc2');
    expect(gets).toContain('/api/accounting/business-units?active=true');
  });

  it('sends each picker\'s own field, and the header project — which pre-fills a line added after it', async () => {
    serve();
    render(<NewCustomerInvoicePage />);
    await fillNewInvoice();
    fireEvent.change(screen.getByLabelText('Revenue account'), { target: { value: ACC.commercials } });
    fireEvent.click(dimensions());
    fireEvent.change(screen.getByLabelText('CC2 project'), { target: { value: CC2 } });
    fireEvent.change(screen.getByLabelText('BU'), { target: { value: BU } });
    fireEvent.change(screen.getByLabelText('Invoice job'), { target: { value: P1 } });
    fireEvent.click(screen.getByRole('button', { name: /Add Line/ }));
    expect((screen.getAllByLabelText('Job (Project Profitability)')[1] as HTMLSelectElement).value).toBe(P1);
    expect((screen.getAllByLabelText('Job (Project Profitability)')[0] as HTMLSelectElement).value).toBe(''); // existing lines untouched
    fireEvent.change(screen.getAllByLabelText('Description')[1]!, { target: { value: 'Edit' } });
    fireEvent.change(screen.getAllByLabelText('Unit price')[1]!, { target: { value: '200' } });
    fireEvent.click(screen.getByRole('button', { name: /Create Invoice/ }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.body.projectId).toBe(P1);
    expect(sent[0]!.body.items).toMatchObject([
      { glAccountId: ACC.commercials, projectId: '', cc2Id: CC2, buId: BU },
      { glAccountId: '', projectId: P1, cc2Id: '', buId: '' },
    ]);
  });

  it('an untouched line follows the header project; a line someone has typed into keeps its own', async () => {
    serve();
    render(<NewCustomerInvoicePage />);
    await fillNewInvoice(); // the first line is now worked
    fireEvent.click(screen.getByRole('button', { name: /Add Line/ })); // a pristine second line
    fireEvent.click(dimensions());
    fireEvent.change(screen.getByLabelText('Invoice job'), { target: { value: P1 } });
    const projects = screen.getAllByLabelText('Job (Project Profitability)') as HTMLSelectElement[];
    expect(projects.map((p) => p.value)).toEqual(['', P1]);
  });

  it('scan-filled lines start on the header project', async () => {
    serve();
    render(<NewCustomerInvoicePage />);
    await waitFor(() => expect(optionTexts(screen.getByLabelText('Invoice job'))).toContain('P1 Shoot'));
    fireEvent.change(screen.getByLabelText('Invoice job'), { target: { value: P1 } });
    fireEvent.click(screen.getByRole('button', { name: 'Scan' }));
    // Dimensions opens itself: the lines now carry a project.
    expect((screen.getAllByLabelText('Job (Project Profitability)') as HTMLSelectElement[]).map((p) => p.value)).toEqual([P1, P1]);
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
    ({ description: 'Spot', quantity: 1, unit_price: 100, amount: 100, gl_account_id: null, project_id: null, cc2_id: null, bu_id: null, ...extra });

  it('round-trips the header project and each line\'s coding, labelling a project past the list by id', async () => {
    router.query = { invoiceId: 'inv-1' };
    serve(invoice([item({ gl_account_id: ACC.commercials, project_id: FAR, cc1_id: 'fno-1', cc2_id: CC2, bu_id: BU }),
      item({ description: 'Old', gl_account_id: ACC.retired })], FAR));
    render(<EditCustomerInvoicePage />);
    const pickers = await screen.findAllByLabelText('Revenue account');
    await waitFor(() => expect((pickers[0] as HTMLSelectElement).value).toBe(ACC.commercials));
    const lineProject = screen.getAllByLabelText('Job (Project Profitability)')[0] as HTMLSelectElement; // Dimensions open: a line carries one
    await waitFor(() => expect(lineProject.selectedOptions[0]!.textContent).toBe('P250 Long-running series'));
    expect(gets.some((u) => u.includes(`/projects?ids=${FAR}`))).toBe(true);
    expect((screen.getByLabelText('Invoice job') as HTMLSelectElement).value).toBe(FAR);
    expect((pickers[1] as HTMLSelectElement).selectedOptions[0]!.textContent).toBe('Unavailable — choose another');
    // CC2 / BU show what is saved and are editable; CC1 is not shown and follows its CC2.
    const cc2 = screen.getAllByLabelText('CC2 project')[0] as HTMLSelectElement;
    await waitFor(() => expect(cc2.selectedOptions[0]!.textContent).toBe('LAW Lawley'));
    expect(cc2.disabled).toBe(false);
    expect((screen.getAllByLabelText('BU')[0] as HTMLSelectElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: /Save Changes/ }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.body.projectId).toBe(FAR);
    expect(sent[0]!.body.items).toMatchObject([
      { glAccountId: ACC.commercials, projectId: FAR, cc2Id: CC2, buId: BU, cc1Id: 'fno-1' },
      { glAccountId: ACC.retired, projectId: null, cc2Id: null, buId: null },
    ]);
    expect('cc1Id' in (sent[0]!.body.items as Record<string, unknown>[])[1]!).toBe(false);
  });

  it("changing a line's CC2 (or clearing it, or its BU) sends the new values and leaves its CC1 to derivation", async () => {
    router.query = { invoiceId: 'inv-1' };
    serve(invoice([item({ cc1_id: 'fno-1', cc2_id: CC2, bu_id: BU })]));
    render(<EditCustomerInvoicePage />);
    const cc2 = (await screen.findAllByLabelText('CC2 project'))[0] as HTMLSelectElement;
    await waitFor(() => expect(cc2.value).toBe(CC2));
    fireEvent.change(cc2, { target: { value: '' } });
    fireEvent.change(screen.getAllByLabelText('BU')[0] as HTMLSelectElement, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /Save Changes/ }));
    await waitFor(() => expect(sent).toHaveLength(1));
    const [line] = sent[0]!.body.items as Record<string, unknown>[];
    expect(line).toMatchObject({ cc2Id: null, buId: null });
    expect('cc1Id' in line!).toBe(false);
  });
});

describe('customer invoice line coding — edit, more', () => {
  const item = (extra: Record<string, unknown>) =>
    ({ description: 'Spot', quantity: 1, unit_price: 100, amount: 100, gl_account_id: null, project_id: null, cc2_id: null, bu_id: null, ...extra });
  const invoice = (items: Record<string, unknown>[], projectId: string | null) => ({
    id: 'inv-1', status: 'draft', invoice_number: 'INV-1', client_id: 'cust-1', invoice_date: '2026-07-15',
    tax_rate: 15, currency_code: 'ZAR', project_id: projectId, items,
  });

  it('a line added on the edit page starts on the header project; so does an invoice\'s first line when it has none', async () => {
    router.query = { invoiceId: 'inv-1' };
    serve(invoice([], P1));
    render(<EditCustomerInvoicePage />);
    await waitFor(() => expect((screen.getAllByLabelText('Job (Project Profitability)')[0] as HTMLSelectElement).value).toBe(P1));
    fireEvent.click(screen.getByRole('button', { name: /Add Line/ }));
    expect((screen.getAllByLabelText('Job (Project Profitability)') as HTMLSelectElement[]).map((p) => p.value)).toEqual([P1, P1]);
  });

  it('a failed by-id lookup reads "could not load", and Retry fetches again and names it', async () => {
    router.query = { invoiceId: 'inv-1' };
    serve(invoice([item({ project_id: FAR })], null), { failIdsOnce: true });
    render(<EditCustomerInvoicePage />);
    const lineProject = await screen.findByLabelText('Job (Project Profitability)') as HTMLSelectElement;
    await waitFor(() => expect(lineProject.selectedOptions[0]!.textContent).toBe('Could not load the list — kept as saved'));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect((screen.getByLabelText('Job (Project Profitability)') as HTMLSelectElement).selectedOptions[0]!.textContent)
      .toBe('P250 Long-running series'));
  });
});

describe('the approver sees what each line posts to', () => {
  it('names the account, job, CC1, CC2 project and BU — the job and the CC2 apart — or the default sales account', () => {
    const base = { id: 'i', description: 'x', quantity: 1, unit_price: 1, amount: 1, tax_rate: 15 };
    expect(lineCoding({ ...base, gl_account_id: 'a', gl_account_code: '4100', gl_account_name: 'Commercials', project_number: 'P1',
      line_project_name: 'Shoot', cc1_code: 'FT', cc1_name: 'FibreTime', cc2_code: 'LAW', cc2_name: 'Lawley', bu_code: 'ACT', bu_name: 'Act' }))
      .toBe('Revenue: 4100 Commercials · Job: P1 Shoot · CC1: FT FibreTime · CC2 project: LAW Lawley · BU: ACT Act');
    expect(lineCoding(base)).toBe('Revenue: default sales account');
    expect(lineCoding({ ...base, gl_account_id: 'gone' })).toBe('Revenue: unknown account');
    expect(lineCoding({ ...base, project_id: 'gone', cc1_id: 'gone', cc2_id: 'gone', bu_id: 'gone' }))
      .toBe('Revenue: default sales account · Job: unknown · CC1: unknown · CC2 project: unknown · BU: unknown');
    expect(lineCoding({ ...base, project_id: 'p', project_number: 'P1', line_project_name: 'Shoot', cc2_id: 'gone' }))
      .toBe('Revenue: default sales account · Job: P1 Shoot · CC2 project: unknown');
    expect(lineCoding({ ...base, gl_account_id: 'a', gl_account_code: '4100', gl_account_name: 'Commercials', account_posted: false }))
      .toBe('Revenue: as posted — see the journal');
    expect(lineCoding({ ...base, gl_account_id: 'a', gl_account_code: '4100', gl_account_name: 'Commercials', account_posted: true }))
      .toBe('Revenue: 4100 Commercials');
  });
});

describe('a stored id the list does not offer', () => {
  const all = (status: 'loading' | 'ready' | 'failed', known: Record<string, string> = {}) =>
    ({ accounts: [], projects: [], cc2s: [], bus: [], known, status, error: '' });
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
