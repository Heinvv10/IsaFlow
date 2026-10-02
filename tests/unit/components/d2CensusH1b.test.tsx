/**
 * D2 census group 1 (a), second half: the reconciliation detail, the customer statement PDF header, the PO edit
 * account list, the supplier payment form and the bank-transaction smart categorisation. A 400 envelope shows
 * the server message, an empty-body 500 shows a plain sentence (never the JSON parse error), a 200 still works.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

const router = vi.hoisted(() => ({ query: { reconId: 'r1', poId: 'po-1' } as Record<string, string>, push: vi.fn(), isReady: true }));
const pdf = vi.hoisted(() => ({ generateStatementPdf: vi.fn() }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/utils/toast', () => ({ notify: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock('next/router', () => ({ useRouter: () => router }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/accounting/bank/ReconciliationBalances', () => ({ ReconciliationBalances: () => null }));
vi.mock('@/components/accounting/ConfirmDialog', () => ({ ConfirmDialog: () => null }));
vi.mock('@/components/accounting/ScanAndFillButton', () => ({ ScanAndFillButton: () => null }));
vi.mock('@/components/accounting/CreateRuleModal', () => ({ extractPattern: () => '' }));
vi.mock('@/components/accounting/supplier-invoices/matchVendorSupplier', () => ({ useVendorSupplierMatch: () => ({ scan: vi.fn(), notePick: vi.fn() }) }));
vi.mock('@/components/accounting/supplier-invoices/SupplierSelect', () => ({
  SupplierSelect: ({ onChange }: { onChange: (id: string, name: string) => void }) => <button type="button" onClick={() => onChange('s1', 'D2 Supplier')}>pick supplier</button>,
}));
vi.mock('@/components/accounting/statements/CustomerStatementPreview', () => ({
  CustomerStatementPreview: ({ statement }: { statement: { customer: { name: string } } }) => <div>STATEMENT {statement.customer.name}</div>,
}));
vi.mock('@/modules/accounting/utils/statementPdf', () => pdf);

import { apiFetch } from '@/lib/apiFetch';
import { notify } from '@/utils/toast';
import { buildBankTxActions } from '@/components/accounting/bank-transactions/useBankTxActions';
import ReconciliationDetailPage from '../../../pages/accounting/bank-reconciliation/[reconId]';
import CustomerStatementPage from '../../../pages/accounting/customers/statement';
import PurchaseOrderDetailPage from '../../../pages/accounting/purchase-orders/[poId]';
import NewSupplierPaymentPage from '../../../pages/accounting/supplier-payments/new';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
beforeEach(() => { vi.mocked(notify.error).mockClear(); vi.mocked(notify.success).mockClear(); });
afterEach(() => { cleanup(); });

const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const envelope = (m: string) => new Response(JSON.stringify({ success: false, error: { code: 'BAD_REQUEST', message: m } }), { status: 400 });
const empty500 = () => new Response('', { status: 500 });
const MSG = 'D2 server says no: this data is not available';
const noParserText = () => expect(screen.queryByText(/JSON|Unexpected end/)).toBeNull();

type Match = (url: string) => boolean;
function script(fails: Match, answer: () => Response, rest: (url: string) => unknown) {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url) => {
    const u = String(url);
    return fails(u) ? answer() : ok(rest(u));
  });
}

describe('bank reconciliation detail', () => {
  const recon = { id: 'r1', bankAccountId: 'ba1', bankAccountName: 'D2 Business Account', statementDate: '2026-01-31', status: 'open', difference: 5 };
  const tx = { id: 't1', description: 'D2 bank line', amount: 5, status: 'imported', transactionDate: '2026-01-01' };
  const rest = (u: string) => (u.includes('bank-reconciliations') ? recon : u.includes('bank-transactions') ? { transactions: [tx] } : { entries: [] });
  const cases: Array<[string, Match, RegExp]> = [
    ['reconciliation', u => u.includes('bank-reconciliations'), /Could not load the reconciliation - try again/],
    ['transactions', u => u.includes('bank-transactions'), /Could not load the reconciliation transactions - try again/],
    ['ledger lines', u => u.includes('journal-entries'), /Could not load the bank ledger lines - try again/],
  ];
  describe.each(cases)('%s', (_n, fails, plain) => {
    it('400: the server message is shown', async () => {
      script(fails, () => envelope(MSG), rest);
      render(<ReconciliationDetailPage />);
      expect(await screen.findByText(new RegExp(MSG))).toBeTruthy();
    });
    it('500 with an empty body: a plain sentence, not a JSON parse error', async () => {
      script(fails, empty500, rest);
      render(<ReconciliationDetailPage />);
      expect(await screen.findByText(plain)).toBeTruthy();
      noParserText();
    });
  });
  it('200: the reconciliation and its lines render', async () => {
    script(() => false, empty500, rest);
    render(<ReconciliationDetailPage />);
    expect((await screen.findAllByText(/D2 bank line/)).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Could not load|D2 server says no/)).toBeNull();
  });
});

describe('customer statement: company details for the PDF', () => {
  const rest = (u: string) => {
    if (u.includes('/customer-statement')) return { customer: { id: 'c1', name: 'D2 Customer' }, fromDate: '2025-01-01', toDate: '2026-01-01', transactions: [],
      summary: { totalInvoiced: 0, totalPaid: 0, totalCredits: 0, balance: 0, openingBalance: 0 } };
    if (u.includes('/customers?')) return [{ id: 'c1', name: 'D2 Customer' }];
    return {};
  };
  async function openPdf(company: () => Response) {
    script(u => u.includes('company-details'), company, rest);
    render(<CustomerStatementPage />);
    fireEvent.change(screen.getByPlaceholderText('Type to search...'), { target: { value: 'D2' } });
    fireEvent.click(await screen.findByRole('button', { name: 'D2 Customer' }));
    fireEvent.click(screen.getByRole('button', { name: 'Preview Statement' }));
    await screen.findByText('STATEMENT D2 Customer');
    fireEvent.click(screen.getByRole('button', { name: 'Download PDF' }));
  }
  beforeEach(() => {
    pdf.generateStatementPdf.mockReset().mockResolvedValue(new Blob(['x']));
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:d2'), revokeObjectURL: vi.fn() }));
  });
  it('400: the server message is shown and no PDF is built', async () => {
    await openPdf(() => envelope(MSG));
    expect(await screen.findByText(new RegExp(MSG))).toBeTruthy();
    expect(pdf.generateStatementPdf).not.toHaveBeenCalled();
  });
  it('500 with an empty body: a plain sentence, not a JSON parse error', async () => {
    await openPdf(empty500);
    expect(await screen.findByText(/Could not load your company details for the PDF - try again/)).toBeTruthy();
    noParserText();
    expect(pdf.generateStatementPdf).not.toHaveBeenCalled();
  });
  it('200: the PDF is built with the company details', async () => {
    await openPdf(() => ok({ name: 'D2 Company Ltd', vat_number: '4D2' }));
    await waitFor(() => expect(pdf.generateStatementPdf).toHaveBeenCalledWith(expect.objectContaining({ companyName: 'D2 Company Ltd', companyVatNumber: '4D2' })));
    expect(screen.queryByText(/Could not load/)).toBeNull();
  });
});

describe('purchase order edit: GL account list', () => {
  const po = { id: 'po-1', po_number: 'PO-D2-1', supplier_id: 's1', supplier_name: 'D2 Supplier', supplier_email: null, supplier_phone: null, order_date: '2026-01-01',
    expected_delivery_date: null, status: 'draft', subtotal: 1, tax_amount: 0, total: 1, notes: null, reference: null, created_at: '2026-01-01T00:00:00Z',
    items: [{ id: 'l1', description: 'D2 line', quantity: 1, unit_price: 1, tax_rate: 0, gl_account_id: null }] };
  const rest = (u: string) => (u.includes('chart-of-accounts') ? [] : po);
  const edit = async () => { fireEvent.click(await screen.findByRole('button', { name: /Edit/ })); };
  it('400: the server message is shown', async () => {
    script(u => u.includes('chart-of-accounts'), () => envelope(MSG), rest);
    render(<PurchaseOrderDetailPage />); await edit();
    expect(await screen.findByText(new RegExp(MSG))).toBeTruthy();
  });
  it('500 with an empty body: a plain sentence, not a JSON parse error', async () => {
    script(u => u.includes('chart-of-accounts'), empty500, rest);
    render(<PurchaseOrderDetailPage />); await edit();
    expect(await screen.findByText(/Could not load GL accounts - try again/)).toBeTruthy();
    noParserText();
  });
  it('200: the accounts fill the line selects', async () => {
    script(() => false, empty500, u => (u.includes('chart-of-accounts') ? [{ id: 'a1', code: '5D2', name: 'D2 Cost Account' }] : po));
    render(<PurchaseOrderDetailPage />); await edit();
    expect((await screen.findAllByText(/5D2 – D2 Cost Account/)).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Could not load/)).toBeNull();
  });
});

describe('new supplier payment', () => {
  const inv = { id: 'i1', invoiceNumber: 'INV-D2-1', totalAmount: 100, balance: 100 };
  async function pickSupplier(fails: Match, answer: () => Response) {
    script(fails, answer, u => (u.includes('supplier-invoices') ? { invoices: [inv] } : { id: 'p9' }));
    const view = render(<NewSupplierPaymentPage />);
    fireEvent.click(screen.getByRole('button', { name: 'pick supplier' }));
    return view;
  }
  const submit = (c: HTMLElement) => fireEvent.submit(c.querySelector('form') as HTMLFormElement);
  const invoices: Match = u => u.includes('supplier-invoices');
  const create: Match = u => u.endsWith('/supplier-payments');

  it('invoices 400: the server message is shown', async () => {
    await pickSupplier(invoices, () => envelope(MSG));
    expect(await screen.findByText(new RegExp(MSG))).toBeTruthy();
  });
  it('invoices 500 with an empty body: a plain sentence, not a JSON parse error', async () => {
    await pickSupplier(invoices, empty500);
    expect(await screen.findByText(/Could not load outstanding invoices - try again/)).toBeTruthy();
    noParserText();
  });
  it('invoices 200: the outstanding invoices are offered', async () => {
    await pickSupplier(() => false, empty500);
    expect((await screen.findAllByText(/INV-D2-1/)).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Could not load/)).toBeNull();
  });
  it('create 400: the server message is shown', async () => {
    const { container } = await pickSupplier(create, () => envelope(MSG));
    await screen.findAllByText(/INV-D2-1/); submit(container);
    expect(await screen.findByText(new RegExp(MSG))).toBeTruthy();
    expect(router.push).not.toHaveBeenCalled();
  });
  it('create 500 with an empty body: a plain sentence, not a JSON parse error', async () => {
    const { container } = await pickSupplier(create, empty500);
    await screen.findAllByText(/INV-D2-1/); submit(container);
    expect(await screen.findByText(/Could not create the payment - try again/)).toBeTruthy();
    noParserText();
  });
  it('create 200: the new payment opens', async () => {
    router.push.mockReset();
    const { container } = await pickSupplier(() => false, empty500);
    await screen.findAllByText(/INV-D2-1/); submit(container);
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/accounting/supplier-payments/p9'));
  });
});

describe('bank transactions: smart categorisation after Apply rules', () => {
  const actions = (onLlmResidual = vi.fn()) => buildBankTxActions({
    transactions: [], glAccounts: [], selectedBank: 'bank-1', selectedIds: new Set(), rowSelections: {},
    batchType: 'account', excludingTxId: null, createEntityTxId: null,
    setSmartRunning: vi.fn(), setRowSelections: vi.fn(), setTransactions: vi.fn(), setSelectedIds: vi.fn(),
    setShowBatchEdit: vi.fn(), setRulePrompt: vi.fn(), setExcludingTxId: vi.fn(),
    loadTransactions: vi.fn(), refreshBankAccounts: vi.fn(), onLlmResidual,
  });
  const run = async (smart: () => Response) => {
    vi.mocked(apiFetch).mockReset().mockImplementation(async (url) => (String(url).includes('smart-categorize') ? smart() : ok({ applied: 2 })));
    await actions().handleApplyRules();
  };
  it('400: the server message reaches the toast', async () => {
    await run(() => envelope(MSG));
    expect(notify.error).toHaveBeenCalledWith(MSG);
  });
  it('500 with an empty body: a plain sentence reaches the toast', async () => {
    await run(empty500);
    expect(notify.error).toHaveBeenCalledWith('Smart categorisation could not run - try again');
    expect(JSON.stringify(vi.mocked(notify.error).mock.calls)).not.toMatch(/JSON|Unexpected end/);
  });
  it('200: the smart count is reported and no error is shown', async () => {
    await run(() => ok({ categorized: 3, skipped: 1 }));
    expect(notify.error).not.toHaveBeenCalled();
    expect(notify.success).toHaveBeenCalledWith('2 rules applied, 3 smart-categorised, 1 skipped');
  });
});
