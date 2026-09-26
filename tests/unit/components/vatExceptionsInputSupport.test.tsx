// VAT201ExceptionsPanel renders the input-VAT support findings: the
// "exceeds its support" section is BLOCKING (Hein, 2026-09-26 — amount
// mismatches mean the return's figures are wrong), and the "no tax invoice
// on file" section (now also carrying no-document / unreadable-document
// rows) is NOT blocking, each with its own count and rows.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('@/lib/apiFetch', async (original) => ({ ...await original<typeof import('@/lib/apiFetch')>(), apiFetch: vi.fn() }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'owner' }) }));

import { apiFetch } from '@/lib/apiFetch';
import { VAT201ExceptionsPanel } from '@/components/accounting/sars/VAT201ExceptionsPanel';
import type { InputVatSupportLine, VatExceptionsReport } from '@/modules/accounting/services/reports/vatExceptionsTypes';

const line = (over: Partial<InputVatSupportLine>): InputVatSupportLine => ({
  journalEntryId: 'je-1', entryNumber: 'JE-2026-00042', entryDate: '2026-07-25', source: 'manual',
  description: 'Hand journal', claimedVat: 15, supportKind: 'captured_document', documentVat: 10,
  reason: 'amount_mismatch', ...over,
});

const report: VatExceptionsReport = {
  periodStart: '2026-07-01', periodEnd: '2026-08-31',
  uncodedGlLines: [], uncodedGlLineCount: 0, invoiceTaxCodeIssues: [], invoiceTaxCodeIssueCount: 0,
  invoiceGlMismatches: [], invoiceGlMismatchCount: 0, vatOnBalanceSheetLines: [], vatOnBalanceSheetCount: 0,
  vatNonSupplyLines: [], vatNonSupplyCount: 0,
  controlRecon: {
    outputVat201: 0, outputGl: 0, outputVariance: 0, inputVat201: 30, inputGl: 30, inputVariance: 0,
    netVat201: -30, netGl: -30, netVariance: 0, unpostedCustomerVat: 0, unpostedCustomerCount: 0,
    unpostedSupplierVat: 0, unpostedSupplierCount: 0,
  },
  unpostedInvoiceVat: [{
    invoiceId: 'ci-9', invoiceKind: 'customer', invoiceNumber: 'INV-0099', counterpartyName: 'Acme',
    invoiceDate: '2026-07-03', vat: 150, reason: 'no_journal',
  }],
  unpostedInvoiceVatCount: 1,
  declaredElsewhereVat: [],
  declaredElsewhereVatCount: 0,
  unsupportedInputVat: [line({})],
  unsupportedInputVatCount: 1,
  inputVatWithoutTaxInvoice: [line({
    journalEntryId: 'je-2', entryNumber: 'JE-2026-00043', supportKind: 'bank', reason: 'no_tax_invoice',
    description: 'Bank allocation', documentVat: null,
  })],
  inputVatWithoutTaxInvoiceCount: 1,
  // unpostedInvoiceVat (1) and unsupportedInputVat (1, an amount_mismatch)
  // both block; inputVatWithoutTaxInvoice does not.
  totalExceptions: 2,
  degradedData: false,
  degradedSources: [],
};

afterEach(() => vi.clearAllMocks());

it('shows the blocking "exceeds its support" section and the non-blocking "no tax invoice" section with their rows', async () => {
  vi.mocked(apiFetch).mockResolvedValue(new Response(JSON.stringify({ success: true, data: report }), { status: 200 }));
  render(<VAT201ExceptionsPanel from="2026-07-01" to="2026-08-31" reloadKey={1} />);

  await waitFor(() => expect(screen.getByText('2 exceptions')).toBeTruthy());
  fireEvent.click(screen.getByText('Invoices with VAT not posted to the GL'));
  expect(screen.getByText('INV-0099')).toBeTruthy();

  fireEvent.click(screen.getByText('Input VAT that exceeds its support'));
  expect(screen.getByText('JE-2026-00042')).toBeTruthy();
  expect(screen.getByText('Differs from its document')).toBeTruthy();
  expect(screen.getByText('Captured document')).toBeTruthy();

  fireEvent.click(screen.getByText('Input VAT with no tax invoice on file (not blocking)'));
  expect(screen.getByText('JE-2026-00043')).toBeTruthy();
  expect(screen.getByText('Bank line only')).toBeTruthy();
  expect(screen.getByText('No tax invoice on file')).toBeTruthy();
});

it('a document_unlinked row says its document was removed, not "Nothing"', async () => {
  const unlinked = { ...report, unsupportedInputVat: [line({ supportKind: 'none', reason: 'document_unlinked', documentVat: null })] };
  vi.mocked(apiFetch).mockResolvedValue(new Response(JSON.stringify({ success: true, data: unlinked }), { status: 200 }));
  render(<VAT201ExceptionsPanel from="2026-07-01" to="2026-08-31" reloadKey={1} />);

  await waitFor(() => expect(screen.getByText('2 exceptions')).toBeTruthy());
  fireEvent.click(screen.getByText('Input VAT that exceeds its support'));
  expect(screen.getByText('Document removed')).toBeTruthy();
  expect(screen.queryByText('Nothing')).toBeNull();
});
