// Hein's decision, 2026-09-27: the pre-filing gate blocks only where the
// return's figures could be wrong in SARS's favour AGAINST THE VENDOR. A
// supplier bill with no tax rate, or a rate but zero VAT, can only mean LESS
// input VAT was claimed than the bill's own rate supports — never more — so
// VAT201ExceptionsPanel renders it as a non-blocking warning, while the
// equivalent CUSTOMER-invoice section stays blocking-styled.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('@/lib/apiFetch', async (original) => ({ ...await original<typeof import('@/lib/apiFetch')>(), apiFetch: vi.fn() }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'owner' }) }));

import { apiFetch } from '@/lib/apiFetch';
import { VAT201ExceptionsPanel } from '@/components/accounting/sars/VAT201ExceptionsPanel';
import type { VatExceptionsReport } from '@/modules/accounting/services/reports/vatExceptionsTypes';

const report: VatExceptionsReport = {
  periodStart: '2026-07-01', periodEnd: '2026-08-31',
  uncodedGlLines: [], uncodedGlLineCount: 0,
  invoiceTaxCodeIssues: [{
    invoiceId: 'ci-1', invoiceKind: 'customer', invoiceNumber: 'INV-0042', counterpartyName: 'Acme Ltd',
    invoiceDate: '2026-07-05', subtotal: 1000, taxRate: null, taxAmount: 0, issue: 'missing_tax_rate',
  }],
  invoiceTaxCodeIssueCount: 1,
  billTaxCodeWarnings: [{
    invoiceId: 'si-9', invoiceKind: 'supplier', invoiceNumber: 'BILL-0099', counterpartyName: 'Gamma Suppliers',
    invoiceDate: '2026-07-10', subtotal: 2000, taxRate: 15, taxAmount: 0, issue: 'rate_without_vat',
    potentialInputVat: 300,
  }],
  billTaxCodeWarningCount: 1,
  billTaxCodeWarningPotentialVat: 300,
  invoiceGlMismatches: [], invoiceGlMismatchCount: 0,
  vatOnBalanceSheetLines: [], vatOnBalanceSheetCount: 0,
  vatNonSupplyLines: [], vatNonSupplyCount: 0,
  controlRecon: {
    outputVat201: 0, outputGl: 0, outputVariance: 0, inputVat201: 0, inputGl: 0, inputVariance: 0,
    netVat201: 0, netGl: 0, netVariance: 0, unpostedCustomerVat: 0, unpostedCustomerCount: 0,
    unpostedSupplierVat: 0, unpostedSupplierCount: 0,
  },
  unpostedInvoiceVat: [], unpostedInvoiceVatCount: 0,
  declaredElsewhereVat: [], declaredElsewhereVatCount: 0,
  unsupportedInputVat: [], unsupportedInputVatCount: 0,
  inputVatWithoutTaxInvoice: [], inputVatWithoutTaxInvoiceCount: 0,
  // Only the customer tax-code issue blocks; the bill warning does not.
  totalExceptions: 1,
  degradedData: false,
  degradedSources: [],
};

afterEach(() => vi.clearAllMocks());

it('renders the bill section as not-blocking with its potential VAT, and keeps the customer section blocking', async () => {
  vi.mocked(apiFetch).mockResolvedValue(new Response(JSON.stringify({ success: true, data: report }), { status: 200 }));
  render(<VAT201ExceptionsPanel from="2026-07-01" to="2026-08-31" reloadKey={1} />);

  await waitFor(() => expect(screen.getByText('1 exception')).toBeTruthy());

  // Customer section: blocking, unchanged title.
  fireEvent.click(screen.getByText('Customer invoices with tax-code issues'));
  expect(screen.getByText('INV-0042')).toBeTruthy();
  expect(screen.getByText('No tax code')).toBeTruthy();

  // Bill section: not-blocking, its own title, shows the potential input VAT.
  const billSectionTitle = 'Supplier bills with a VAT rate but no VAT — possible unclaimed input VAT (not blocking)';
  fireEvent.click(screen.getByText(billSectionTitle));
  expect(screen.getByText('BILL-0099')).toBeTruthy();
  expect(screen.getByText('Tax code set, zero VAT')).toBeTruthy();
  // The potential input VAT total appears both in the narrative and the row
  // (en-ZA formatting: "R 300,00").
  expect(screen.getAllByText(/R\s*300\.00/).length).toBeGreaterThan(0);
});
