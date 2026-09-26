/**
 * vat_exceptions — wraps getVatExceptions into typed categories, each marked
 * blocking/non-blocking, plus the override history for the period.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
  getVatExceptions: vi.fn(),
  listVatGateOverrides: vi.fn(),
}));
vi.mock('@/modules/accounting/services/reports/vatExceptionsService', () => ({
  getVatExceptions: m.getVatExceptions,
}));
vi.mock('@/modules/accounting/services/reports/vatGateOverrideService', () => ({
  listVatGateOverrides: m.listVatGateOverrides,
}));

import { vatExceptionsTool } from '@/lib/mcp/tools/vatExceptions';
import type { McpToolContext } from '@/lib/mcp/types';

const COMPANY = 'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa';
const ctx: McpToolContext = { userId: 'u1', companyId: COMPANY, scopes: ['read:vat'], tokenJti: 'tok-1', oauthAppId: null };

function text(result: { content: { text: string }[] }) {
  return JSON.parse(result.content[0]!.text);
}

const REPORT = {
  periodStart: '2026-07-01', periodEnd: '2026-08-31',
  uncodedGlLines: [{ id: 1 }], uncodedGlLineCount: 1,
  invoiceTaxCodeIssues: [], invoiceTaxCodeIssueCount: 0,
  invoiceGlMismatches: [], invoiceGlMismatchCount: 0,
  vatOnBalanceSheetLines: [], vatOnBalanceSheetCount: 0,
  vatNonSupplyLines: [], vatNonSupplyCount: 0,
  controlRecon: { outputVariance: 0, inputVariance: 0 },
  unpostedInvoiceVat: [], unpostedInvoiceVatCount: 0,
  declaredElsewhereVat: [{ invoiceId: 'x' }], declaredElsewhereVatCount: 1,
  unsupportedInputVat: [{ journalEntryId: 'je-1' }], unsupportedInputVatCount: 1,
  inputVatWithoutTaxInvoice: [], inputVatWithoutTaxInvoiceCount: 0,
  totalExceptions: 2,
  degradedData: false, degradedSources: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  m.getVatExceptions.mockResolvedValue(REPORT);
  m.listVatGateOverrides.mockResolvedValue([{ id: 'ov-1', reason: 'filed under old system' }]);
});

it('refuses missing period args', async () => {
  const result = await vatExceptionsTool.handler({}, ctx);
  expect(result.isError).toBe(true);
});

it('refuses period_start after period_end', async () => {
  const result = await vatExceptionsTool.handler({ period_start: '2026-08-31', period_end: '2026-07-01' }, ctx);
  expect(result.isError).toBe(true);
});

it('scopes both queries to the caller company and period', async () => {
  await vatExceptionsTool.handler({ period_start: '2026-07-01', period_end: '2026-08-31' }, ctx);
  expect(m.getVatExceptions).toHaveBeenCalledWith(COMPANY, '2026-07-01', '2026-08-31');
  expect(m.listVatGateOverrides).toHaveBeenCalledWith(COMPANY, '2026-07-01', '2026-08-31');
});

it('marks each category blocking/non-blocking with its count and items', async () => {
  const result = await vatExceptionsTool.handler({ period_start: '2026-07-01', period_end: '2026-08-31' }, ctx);
  const body = text(result);
  expect(body.totalExceptions).toBe(2);
  const byType = Object.fromEntries(body.categories.map((c: { type: string }) => [c.type, c]));
  expect(byType.uncodedGlLines).toMatchObject({ blocking: true, count: 1 });
  // Non-blocking (Hein, 2026-09-26): holding a tax invoice is the vendor's
  // legal responsibility, which may be discharged outside IsaFlow.
  expect(byType.unsupportedInputVat).toMatchObject({ blocking: false, count: 1, items: [{ journalEntryId: 'je-1' }] });
  expect(byType.declaredElsewhereVat).toMatchObject({ blocking: false, count: 1 });
  expect(byType.inputVatWithoutTaxInvoice).toMatchObject({ blocking: false, count: 0 });
  expect(body.overrideHistory).toEqual([{ id: 'ov-1', reason: 'filed under old system' }]);
});
