// A failed load/action shows the server's message (400) or a plain sentence (empty 500), never a blank table or a raw JSON error.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { MSG, bad400, empty500, okRes, rawJsonError, router } from '../helpers/d2CensusG6';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

const routerState = vi.hoisted(() => ({ query: {} as Record<string, string> }));
vi.mock('next/link', () => ({ default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: routerState.query, push: vi.fn(), replace: vi.fn() }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/components/accounting/supplier-invoices/SupplierSelect', () => ({ SupplierSelect: () => null }));
useApiJsonOverMock();

import { apiFetch } from '@/lib/apiFetch';
import ReportTemplatesPage from '../../../pages/accounting/afs/report-templates';
import SentMirrorPage from '../../../pages/accounting/ar/settings/sent-mirror';
import ProvisionalPage from '../../../pages/accounting/bank/provisional';
import NewCreditNotePage from '../../../pages/accounting/credit-notes/new';
import EditCustomerInvoicePage from '../../../pages/accounting/customer-invoices/edit/[invoiceId]';
import SalesOrdersPage from '../../../pages/accounting/customer-sales-orders/index';

const script = (routes: Array<[string, () => Response]>, fallback: unknown = []) => vi.mocked(apiFetch).mockReset().mockImplementation(router(routes, fallback));
const noRawJson = () => expect(document.body.textContent ?? '').not.toMatch(rawJsonError);
beforeEach(() => { routerState.query = {}; });
afterEach(() => { cleanup(); });

describe('AFS report templates', () => {
  const SITE = '/api/accounting/afs/report-templates';
  it('shows the server message on a 400', async () => {
    script([[SITE, bad400]]); render(<ReportTemplatesPage />);
    expect(await screen.findByText(MSG)).toBeTruthy();
  });
  it('shows a plain sentence on an empty 500', async () => {
    script([[SITE, empty500]]); render(<ReportTemplatesPage />);
    expect(await screen.findByText('Could not load report templates - try again')).toBeTruthy(); noRawJson();
  });
  it('renders the templates on success', async () => {
    script([[SITE, () => okRes({ reportType: 'compilation', entityType: 'pty', framework: 'ifrs_smes', templates: {
      practitionerReport: 'D2 practitioner wording', directorsResponsibility: 'x', directorsReport: 'y', generalInformation: 'z' } })]]);
    render(<ReportTemplatesPage />);
    expect(await screen.findByText(/D2 practitioner wording/)).toBeTruthy();
  });
});

describe('Sent-mirror scan log', () => {
  const CONN = { id: 'c1', provider: 'imap', displayName: 'D2 Mailbox', accountEmail: 'a@b.co', status: 'active', sentFolder: 'Sent',
    scanIntervalMinutes: 15, messagesCapturedTotal: 0, messagesLinkedTotal: 0, lastScanAt: null, lastSuccessAt: null, lastError: null };
  const open = async (log: () => Response) => {
    script([['/log?', log], ['/sent-mirror/connections', () => okRes({ items: [CONN] })]]);
    render(<SentMirrorPage />);
    await screen.findByText('D2 Mailbox'); fireEvent.click(screen.getByTitle('Scan log'));
  };
  it('shows the server message on a 400', async () => { await open(bad400); expect(await screen.findByText(MSG)).toBeTruthy(); });
  it('shows a plain sentence on an empty 500', async () => {
    await open(empty500); expect(await screen.findByText('Could not load the scan log - try again')).toBeTruthy(); noRawJson();
  });
  it('lists the log entries on success', async () => {
    await open(() => okRes({ items: [{ id: 'l1', recipient: null, subject: 'D2 subject line', attachment_count: 1, outcome: 'linked', error: null, scanned_at: '2026-01-01T00:00:00Z' }] }));
    expect(await screen.findByText('D2 subject line')).toBeTruthy();
  });
});

describe('Provisional entries attach dialog', () => {
  const ENTRY = { jeId: 'je1', bankTxId: 'b1', bankAccountName: 'Cheque', description: 'd', amount: 10, transactionDate: '2026-01-01', daysOutstanding: 2,
    predictedSupplierId: null, predictedSupplierName: null, predictionConfidence: 0.5, glAccountId: null, glAccountName: null, postedAt: '2026-01-01' };
  const open = async (docs: () => Response) => {
    script([['document-capture', docs], ['provisional/outstanding', () => okRes({ outstanding: [ENTRY] })]]);
    render(<ProvisionalPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Attach evidence/ }));
  };
  it('shows the server message on a 400', async () => { await open(bad400); expect(await screen.findByText(MSG)).toBeTruthy(); });
  it('shows a plain sentence on an empty 500', async () => {
    await open(empty500); expect(await screen.findByText('Could not load documents - try again')).toBeTruthy(); noRawJson();
  });
  it('lists the documents on success', async () => {
    await open(() => okRes([{ id: 'd1', fileName: 'f.pdf', vendorName: 'D2 Vendor Ltd', documentDate: null, totalAmount: 5, documentType: 'invoice' }]));
    expect(await screen.findByText('D2 Vendor Ltd')).toBeTruthy();
  });
});

describe('New credit note client list', () => {
  const SITE = '/api/accounting/customers';
  it('shows the server message on a 400', async () => { script([[SITE, bad400]]); render(<NewCreditNotePage />); expect(await screen.findByText(MSG)).toBeTruthy(); });
  it('shows a plain sentence on an empty 500', async () => {
    script([[SITE, empty500]]); render(<NewCreditNotePage />);
    expect(await screen.findByText('Could not load clients - try again')).toBeTruthy(); noRawJson();
  });
  it('offers the clients on success', async () => {
    script([[SITE, () => okRes([{ id: 'k1', company_name: 'D2 Client Pty' }])]]); render(<NewCreditNotePage />);
    expect(await screen.findByRole('option', { name: 'D2 Client Pty' })).toBeTruthy();
  });
});

describe('Edit customer invoice load', () => {
  const INV = { id: 'i1', invoice_number: 'D2-INV-1', status: 'draft', client_id: 'k1', invoice_date: '2026-01-01', items: [] };
  const open = async (detail: () => Response) => {
    routerState.query = { invoiceId: 'i1' };
    script([['customer-invoices-detail', detail], ['/currencies', () => okRes([])], ['/customers', () => okRes([{ id: 'k1', name: 'D2 Client' }])]]);
    render(<EditCustomerInvoicePage />);
  };
  it('shows the server message on a 400', async () => { await open(bad400); expect(await screen.findByText(MSG)).toBeTruthy(); });
  it('shows a plain sentence on an empty 500', async () => {
    await open(empty500); expect(await screen.findByText('Could not load the invoice - try again')).toBeTruthy(); noRawJson();
  });
  it('shows the invoice on success', async () => { await open(() => okRes(INV)); expect(await screen.findByText('D2-INV-1')).toBeTruthy(); });
  it('shows the server message when the client list is refused', async () => {
    routerState.query = { invoiceId: 'i1' };
    script([['customer-invoices-detail', () => okRes(INV)], ['/currencies', () => okRes([])], ['/customers', bad400]]);
    render(<EditCustomerInvoicePage />);
    await waitFor(() => expect(screen.queryByText(MSG)).not.toBeNull());
  });
});

describe('Customer sales orders list', () => {
  const SITE = 'customer-sales-orders';
  it('shows the server message on a 400', async () => { script([[SITE, bad400]]); render(<SalesOrdersPage />); expect(await screen.findByText(MSG)).toBeTruthy(); });
  it('shows a plain sentence on an empty 500', async () => {
    script([[SITE, empty500]]); render(<SalesOrdersPage />);
    expect(await screen.findByText('Could not load sales orders - try again')).toBeTruthy(); noRawJson();
  });
  it('lists the orders on success', async () => {
    script([[SITE, () => okRes({ orders: [{ id: 'o1', orderNumber: 'D2-SO-77', customerName: 'D2 Customer', orderDate: '2026-01-01', deliveryDate: null, status: 'draft', totalAmount: 10 }], total: 1 })]]);
    render(<SalesOrdersPage />);
    expect(await screen.findByText('D2-SO-77')).toBeTruthy();
  });
});
