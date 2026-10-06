/**
 * Shared setup for the creditNoteTools*.test.ts suites: the module mocks, the
 * fixtures and the result helpers. Split out of creditNoteTools.test.ts to keep
 * each suite under the 300-line limit; imported before anything it mocks.
 */
import { expect, vi, beforeEach } from 'vitest';


// R-035 PR3: the approval pre-read is proven against a real database (r035-pr3-mcp.int.test.ts).
vi.mock('@/modules/accounting/services/gl/approvalUnattended', () => ({ agentApprovalRefusal: vi.fn(async () => null) }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/modules/accounting/services/shared/creditNoteFifo', async () => {
  const actual = await vi.importActual<typeof import('@/modules/accounting/services/shared/creditNoteFifo')>(
    '@/modules/accounting/services/shared/creditNoteFifo',
  );
  return { ...actual, listCreditNoteAllocations: vi.fn() };
});
vi.mock('@/modules/accounting/services/ar/creditNoteService', () => ({
  getCreditNotes: vi.fn(),
  getCreditNoteById: vi.fn(),
  createCreditNote: vi.fn(),
  approveCreditNote: vi.fn(),
  cancelCreditNote: vi.fn(),
}));
vi.mock('@/modules/accounting/services/ar/creditNoteLinkService', () => ({
  validateCreditNoteLinks: vi.fn(),
  findOpenDuplicateDraft: vi.fn(),
}));
vi.mock('@/modules/accounting/services/gl/systemAccountResolver', () => ({
  validateSystemAccounts: vi.fn(),
}));

import { validateCreditNoteLinks, findOpenDuplicateDraft } from '@/modules/accounting/services/ar/creditNoteLinkService';
import { validateSystemAccounts } from '@/modules/accounting/services/gl/systemAccountResolver';
import { listCreditNoteAllocations } from '@/modules/accounting/services/shared/creditNoteFifo';
import type { McpToolContext, McpToolResult } from '@/lib/mcp/types';

export const COMPANY = '11111111-1111-4111-8111-111111111111';
export const CUSTOMER = '22222222-2222-4222-8222-222222222222';
export const SUPPLIER = '33333333-3333-4333-8333-333333333333';
export const CUST_INV = '44444444-4444-4444-8444-444444444444';
export const SUPP_INV = '55555555-5555-4555-8555-555555555555';
export const NOTE = '66666666-6666-4666-8666-666666666666';
export const KEY = { idempotency_key: 'k1' };

export function ctx(): McpToolContext {
  return {
    userId: '99999999-9999-4999-8999-999999999999',
    companyId: COMPANY,
    scopes: ['write:invoices', 'write:post'],
    tokenJti: 'jti',
    oauthAppId: null,
  } as McpToolContext;
}

export function parseOk(r: McpToolResult): Record<string, unknown> {
  expect(r.isError).toBeFalsy();
  return JSON.parse(r.content[0]!.text) as Record<string, unknown>;
}
export function errText(r: McpToolResult): string {
  expect(r.isError).toBe(true);
  return r.content[0]!.text;
}

export const draftNote = {
  id: NOTE,
  creditNoteNumber: 'CN-2026-00001',
  type: 'customer' as const,
  status: 'draft' as const,
  subtotal: 100,
  taxRate: 15,
  taxAmount: 15,
  totalAmount: 115,
  creditDate: '2026-06-30',
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listCreditNoteAllocations).mockResolvedValue([]);
  vi.mocked(validateCreditNoteLinks).mockResolvedValue(null);
  vi.mocked(validateSystemAccounts).mockResolvedValue([]);
  vi.mocked(findOpenDuplicateDraft).mockResolvedValue(null);
});
