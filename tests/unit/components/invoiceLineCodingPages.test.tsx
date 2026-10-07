// The REAL new and edit customer-invoice pages with the shared line table (migration 870): the account picker
// offers only active LEAF revenue accounts, Dimensions offers projects that are not cancelled and active cost
// centres, an edit round-trips what the line was coded to, and a save sends it.
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

const ACC = { commercials: 'a1000000-0000-4000-8000-000000000001', header: 'a1000000-0000-4000-8000-000000000002',
  child: 'a1000000-0000-4000-8000-000000000003', retired: 'a1000000-0000-4000-8000-000000000004',
  crew: 'a1000000-0000-4000-8000-000000000005' };
const P1 = 'b1000000-0000-4000-8000-000000000001';
const CC1 = 'c1000000-0000-4000-8000-000000000001';
const account = (id: string, code: string, name: string, extra: Record<string, unknown> = {}) =>
  ({ id, accountCode: code, accountName: name, accountType: 'revenue', isActive: true, ...extra });

const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
let sent: { url: string; body: Record<string, unknown> }[] = [];

function serve(invoice?: Record<string, unknown>) {
  sent = [];
  vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    if (init?.method === 'POST' || init?.method === 'PUT') {
      sent.push({ url: u, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      return ok({ id: 'inv-1' });
    }
    if (u.includes('chart-of-accounts')) {
      return ok([
        account(ACC.commercials, '4100', 'Commercials'),
        account(ACC.header, '4300', 'Studio header'),
        account(ACC.child, '4310', 'Studio child', { parentAccountId: ACC.header }),
        account(ACC.retired, '4400', 'Retired', { isActive: false }),
        account(ACC.crew, '6100', 'Crew', { accountType: 'expense' }),
      ]);
    }
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

describe('customer invoice line coding — pages', () => {
  it('the account picker offers only active leaf revenue accounts; Dimensions offers live projects and centres', async () => {
    serve();
    render(<NewCustomerInvoicePage />);
    const picker = await screen.findByLabelText('Revenue account');
    await waitFor(() => expect(optionTexts(picker)).toEqual(['Default sales', '4100 Commercials', '4310 Studio child']));
    expect(screen.queryByLabelText('Project')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Dimensions/ }));
    expect(optionTexts(screen.getByLabelText('Project'))).toEqual(['No project', 'P1 Shoot']);
    expect(optionTexts(screen.getByLabelText('Cost centre'))).toEqual(['No cost centre', 'CC1 Studio']);
  });

  it('a new invoice sends the account and project picked for the line', async () => {
    serve();
    render(<NewCustomerInvoicePage />);
    await waitFor(() => expect(optionTexts(screen.getByLabelText('Revenue account'))).toContain('4100 Commercials'));
    await waitFor(() => expect(screen.getAllByRole('option', { name: 'Acme' }).length).toBe(1));
    fireEvent.change(screen.getByDisplayValue('Select client…'), { target: { value: 'cust-1' } });
    fireEvent.change(screen.getByPlaceholderText('Item description'), { target: { value: 'TV spot' } });
    fireEvent.change(document.querySelector('input[name="unitPrice"]')!, { target: { value: '1000' } });
    fireEvent.change(screen.getByLabelText('Revenue account'), { target: { value: ACC.commercials } });
    fireEvent.click(screen.getByRole('button', { name: /Dimensions/ }));
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: P1 } });
    fireEvent.click(screen.getByRole('button', { name: /Create Invoice/ }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect((sent[0]!.body.items as Record<string, unknown>[])[0]).toMatchObject({ glAccountId: ACC.commercials, projectId: P1, costCenterId: '' });
  });

  it('an edit shows what each line is coded to, keeps an id the list no longer offers visible, and saves it back', async () => {
    router.query = { invoiceId: 'inv-1' };
    serve({ id: 'inv-1', status: 'draft', invoice_number: 'INV-1', client_id: 'cust-1', invoice_date: '2026-07-15',
      tax_rate: 15, currency_code: 'ZAR', items: [
        { description: 'Spot', quantity: 1, unit_price: 100, amount: 100, gl_account_id: ACC.commercials, project_id: P1, cost_center_id: CC1 },
        { description: 'Old', quantity: 1, unit_price: 50, amount: 50, gl_account_id: ACC.retired, project_id: null, cost_center_id: null },
      ] });
    render(<EditCustomerInvoicePage />);
    const pickers = await screen.findAllByLabelText('Revenue account');
    await waitFor(() => expect((pickers[0] as HTMLSelectElement).value).toBe(ACC.commercials));
    expect((screen.getAllByLabelText('Project')[0] as HTMLSelectElement).value).toBe(P1); // Dimensions open: a line carries one
    expect((pickers[1] as HTMLSelectElement).selectedOptions[0]!.textContent).toBe('Unavailable — choose another');
    fireEvent.click(screen.getByRole('button', { name: /Save Changes/ }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.body.items).toMatchObject([
      { glAccountId: ACC.commercials, projectId: P1, costCenterId: CC1 },
      { glAccountId: ACC.retired, projectId: null, costCenterId: null },
    ]);
  });
});
