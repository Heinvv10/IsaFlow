/**
 * What a `detail: "summary"` on list_credit_notes / list_supplier_payments does NOT mean, said where an agent reads it:
 *  - credit-note totals add customer notes (a receivable reduction) to supplier notes (a payable reduction) unless the
 *    summary is narrowed or grouped by type, and the reply flags it (`mixes_types: true`);
 *  - both summaries count draft / cancelled rows, so the descriptions point at a status filter or group_by=status.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GroupedSummary } from '@/modules/accounting/services/shared/groupedSummary';

vi.mock('@/lib/neon', () => ({ sql: Object.assign(vi.fn(), { unsafe: vi.fn() }), withSavepoint: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/ar/creditNoteService', () => ({ getCreditNotes: vi.fn(), getCreditNoteById: vi.fn() }));
vi.mock('@/modules/accounting/services/ar/creditNoteSummaryService', () => ({
  CREDIT_NOTE_GROUP_BY: ['status', 'type', 'party', 'month'], summariseCreditNotes: vi.fn(),
}));
vi.mock('@/modules/accounting/services/ap/supplierPaymentListService', () => ({ listSupplierPayments: vi.fn() }));
vi.mock('@/modules/accounting/services/ap/supplierPaymentSummaryService', () => ({
  SUPPLIER_PAYMENT_GROUP_BY: ['supplier', 'status', 'month'], summariseSupplierPayments: vi.fn(),
}));

import { summariseCreditNotes } from '@/modules/accounting/services/ar/creditNoteSummaryService';
import { listCreditNotesTool } from '@/lib/mcp/tools/creditNotes';
import { listSupplierPaymentsTool } from '@/lib/mcp/tools/listSupplierPayments';
import type { McpToolContext, McpToolResult } from '@/lib/mcp/types';

const ctx: McpToolContext = {
  userId: 'u', companyId: '22222222-2222-4222-8222-222222222222', tokenJti: 'j', oauthAppId: null, scopes: ['read:invoices'],
};
const SUMMARY: GroupedSummary = { totals: { count: 4 }, groups: [], groupsTotal: 0, other: null };
const reply = (r: McpToolResult): Record<string, unknown> => JSON.parse(r.content[0]!.text) as Record<string, unknown>;

beforeEach(() => vi.mocked(summariseCreditNotes).mockResolvedValue(SUMMARY));

describe('list_credit_notes summary: mixes_types', () => {
  it.each([
    ['no filter, no group', { detail: 'summary' }],
    ['group_by status', { group_by: 'status' }],
    ['group_by party', { group_by: 'party' }],
    ['group_by month', { group_by: 'month' }],
  ])('flags the mix for %s', async (_n, args) => {
    expect(reply(await listCreditNotesTool.handler(args, ctx)).mixes_types).toBe(true);
  });

  it.each([
    ['group_by type', { group_by: 'type' }],
    ['type customer', { detail: 'summary', type: 'customer' }],
    ['type supplier', { detail: 'summary', type: 'supplier' }],
    ['type customer + group_by type', { type: 'customer', group_by: 'type' }],
    ['type supplier + group_by party', { type: 'supplier', group_by: 'party' }],
  ])('does not flag it for %s', async (_n, args) => {
    expect(reply(await listCreditNotesTool.handler(args, ctx))).not.toHaveProperty('mixes_types');
  });
});

describe('summary descriptions', () => {
  it('list_credit_notes warns about mixed note types and about draft and cancelled notes', () => {
    expect(listCreditNotesTool.description).toContain('without type (or group_by=type) the summary adds the two together');
    expect(listCreditNotesTool.description).toContain('mixes_types: true');
    expect(listCreditNotesTool.description).toContain('Totals also count draft and cancelled notes, which credited nothing');
    expect(listCreditNotesTool.description).toContain('pass status, or group_by=status, to size what was actually credited');
  });

  it('list_supplier_payments warns about draft, approved and cancelled payments', () => {
    expect(listSupplierPaymentsTool.description).toContain('Totals also count draft, approved and cancelled payments');
    expect(listSupplierPaymentsTool.description).toContain('pass status, or group_by=status, to size what was actually paid');
  });
});
