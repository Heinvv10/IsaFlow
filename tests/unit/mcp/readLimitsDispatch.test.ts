/**
 * Paging and `detail: "summary"` / `group_by` at the tool boundary for the seven list reads of the step-7h follow-up.
 *
 *  1. DEFAULT PIN: with no summary argument list_credit_notes / list_supplier_payments / list_documents call their row
 *     service as before (the whole argument object is asserted), never the summary service.
 *  2. SAME FILTERS: the summary service gets the filters the row service gets. A filter mapped for rows and forgotten
 *     for the summary would total a bigger set than the rows it stands in for.
 *  3. Refusals: offset with a summary, an unknown group_by, group_by with row detail, a bad offset, a summary of the
 *     entity store.
 *  4. list_bank_rules / list_work_items page in memory: total and auto_posting_rules describe the WHOLE filtered set,
 *     filters apply before the page is cut, and the last page says so.
 *
 * That a summary's totals equal the rows is proved against a real database in mcp-read-limits.int.test.ts.
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
vi.mock('@/modules/accounting/services/core/documentQueryService', () => ({
  listBankAttachments: vi.fn(), listEntityDocuments: vi.fn(), listTransactionsWithoutDocuments: vi.fn(),
}));
vi.mock('@/modules/accounting/services/core/bankAttachmentSummaryService', () => ({
  BANK_DOCUMENT_GROUP_BY: ['store', 'month'], summariseBankAttachments: vi.fn(),
}));
vi.mock('@/modules/accounting/services/bank/bankTxAttachmentService', () => ({ getBankTxAttachment: vi.fn() }));
vi.mock('@/modules/accounting/services/core/bankLineDocumentRouting', async (orig) => ({
  ...(await orig<Record<string, unknown>>()), bankTxBelongsToCompany: vi.fn(async () => true),
}));
vi.mock('@/modules/accounting/services/bank/bankRulesService', () => ({
  getRules: vi.fn(), createRule: vi.fn(), updateRule: vi.fn(), toggleRule: vi.fn(),
}));
vi.mock('@/modules/accounting/services/practice/practiceJobCategoryService', () => ({
  listJobCategories: vi.fn(), listWorkItems: vi.fn(), createJobCategory: vi.fn(), createWorkItem: vi.fn(),
}));
vi.mock('@/modules/accounting/services/practice/practiceClientService', () => ({ listPracticeClients: vi.fn() }));
vi.mock('@/modules/accounting/services/practice/practiceTimeEntryService', () => ({ listPracticeEntries: vi.fn() }));

import { getCreditNotes } from '@/modules/accounting/services/ar/creditNoteService';
import { summariseCreditNotes } from '@/modules/accounting/services/ar/creditNoteSummaryService';
import { listSupplierPayments } from '@/modules/accounting/services/ap/supplierPaymentListService';
import { summariseSupplierPayments } from '@/modules/accounting/services/ap/supplierPaymentSummaryService';
import { listBankAttachments, listEntityDocuments } from '@/modules/accounting/services/core/documentQueryService';
import { summariseBankAttachments } from '@/modules/accounting/services/core/bankAttachmentSummaryService';
import { getRules } from '@/modules/accounting/services/bank/bankRulesService';
import { listWorkItems } from '@/modules/accounting/services/practice/practiceJobCategoryService';
import { listCreditNotesTool } from '@/lib/mcp/tools/creditNotes';
import { listSupplierPaymentsTool } from '@/lib/mcp/tools/listSupplierPayments';
import { listDocumentsTool } from '@/lib/mcp/tools/listDocuments';
import { listBankRulesTool } from '@/lib/mcp/tools/bankRules';
import { listWorkItemsTool } from '@/lib/mcp/tools/practice';
import type { McpToolContext, McpToolResult } from '@/lib/mcp/types';

const CO = '22222222-2222-4222-8222-222222222222';
const SUP = '33333333-3333-4333-8333-333333333333';
const TX = '44444444-4444-4444-8444-444444444444';
const ctx: McpToolContext = {
  userId: 'u', companyId: CO, tokenJti: 'j', oauthAppId: null,
  scopes: ['read:invoices', 'read:reports', 'read:bank-tx', 'read:practice'],
};
const SUMMARY: GroupedSummary = { totals: { count: 4 }, groups: [{ key: 'k', label: null, values: { count: 4 } }], groupsTotal: 1, other: null };
const parse = (r: McpToolResult): Record<string, unknown> => JSON.parse(r.content[0]!.text) as Record<string, unknown>;
const fails = (r: McpToolResult): string => { expect(r.isError).toBe(true); return r.content[0]!.text; };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(summariseCreditNotes).mockResolvedValue(SUMMARY);
  vi.mocked(summariseSupplierPayments).mockResolvedValue(SUMMARY);
  vi.mocked(summariseBankAttachments).mockResolvedValue(SUMMARY);
});

describe('list_credit_notes', () => {
  const args = { type: 'supplier', status: 'applied' };
  const note = (i: number) => ({ id: `n${i}`, creditNoteNumber: `CN-${i}`, type: 'supplier', creditDate: '2026-11-01', status: 'applied' });

  it('a default call reads rows exactly as before, with next_offset, and never touches the summary service', async () => {
    vi.mocked(getCreditNotes).mockResolvedValue({ creditNotes: [note(1), note(2)], total: 2 } as never);
    const body = parse(await listCreditNotesTool.handler(args, ctx));
    expect(getCreditNotes).toHaveBeenCalledWith(CO, { type: 'supplier', status: 'applied', limit: 50, offset: 0 });
    expect(summariseCreditNotes).not.toHaveBeenCalled();
    expect(Object.keys(body).sort()).toEqual(['credit_notes', 'next_offset', 'total']);
    expect(body.next_offset).toBeNull();
  });

  it('next_offset is the offset of the next page, null on the last', async () => {
    vi.mocked(getCreditNotes).mockResolvedValue({ creditNotes: Array.from({ length: 10 }, (_, i) => note(i)), total: 95 } as never);
    expect(parse(await listCreditNotesTool.handler({ limit: 10, offset: 20 }, ctx)).next_offset).toBe(30);
    expect(parse(await listCreditNotesTool.handler({ limit: 10, offset: 90 }, ctx)).next_offset).toBeNull();
  });

  it('a summary gets the same filters, covers the whole set and answers totals and groups', async () => {
    const body = parse(await listCreditNotesTool.handler({ ...args, group_by: 'party' }, ctx));
    expect(summariseCreditNotes).toHaveBeenCalledWith(CO, { type: 'supplier', status: 'applied' }, 'party');
    expect(getCreditNotes).not.toHaveBeenCalled();
    expect(body).toMatchObject({ detail: 'summary', group_by: 'party', totals: { count: 4 }, groups_total: 1 });
    await listCreditNotesTool.handler({ detail: 'summary' }, ctx);
    expect(summariseCreditNotes).toHaveBeenLastCalledWith(CO, { type: undefined, status: undefined }, null);
  });

  it('says when the totals add customer and supplier notes together, and only then', async () => {
    expect(parse(await listCreditNotesTool.handler({ detail: 'summary' }, ctx)).mixes_types).toBe(true);
    expect(parse(await listCreditNotesTool.handler({ group_by: 'status' }, ctx)).mixes_types).toBe(true);
    expect(parse(await listCreditNotesTool.handler({ group_by: 'type' }, ctx))).not.toHaveProperty('mixes_types');
    expect(parse(await listCreditNotesTool.handler({ detail: 'summary', type: 'customer' }, ctx))).not.toHaveProperty('mixes_types');
  });

  it('the descriptions warn that a summary counts draft and cancelled rows', () => {
    expect(listCreditNotesTool.description).toContain('adds the two together');
    expect(listCreditNotesTool.description).toContain('draft and cancelled');
    expect(listSupplierPaymentsTool.description).toContain('group_by=status');
  });

  it('refuses what a summary or a page cannot take', async () => {
    expect(fails(await listCreditNotesTool.handler({ detail: 'summary', offset: 5 }, ctx))).toContain('omit cursor and offset');
    expect(fails(await listCreditNotesTool.handler({ group_by: 'colour' }, ctx))).toContain('group_by must be one of: status, type, party, month');
    expect(fails(await listCreditNotesTool.handler({ group_by: 'status', detail: 'standard' }, ctx))).toContain('group_by needs detail');
    expect(fails(await listCreditNotesTool.handler({ offset: -1 }, ctx))).toContain('offset must be an integer');
    expect(getCreditNotes).not.toHaveBeenCalled();
    expect(summariseCreditNotes).not.toHaveBeenCalled();
  });
});

describe('list_supplier_payments', () => {
  const args = { supplier_id: SUP, status: 'processed', from_date: '2026-01-01', to_date: '2026-03-31', search: 'abc' };
  const filters = { supplierId: SUP, status: 'processed', fromDate: '2026-01-01', toDate: '2026-03-31', search: 'abc' };
  const totals = { paymentAmount: 10, allocatedAmount: 4, unappliedAmount: 6 };

  it('a default call reads rows exactly as before and never touches the summary service', async () => {
    vi.mocked(listSupplierPayments).mockResolvedValue({ rows: [], total: 0, totals } as never);
    const body = parse(await listSupplierPaymentsTool.handler(args, ctx));
    expect(listSupplierPayments).toHaveBeenCalledWith(CO, { ...filters, limit: 50, offset: 0 });
    expect(summariseSupplierPayments).not.toHaveBeenCalled();
    expect(Object.keys(body).sort()).toEqual(['next_offset', 'payments', 'total', 'totals']);
  });

  it('a summary gets the same filters as the rows', async () => {
    const body = parse(await listSupplierPaymentsTool.handler({ ...args, group_by: 'supplier' }, ctx));
    expect(summariseSupplierPayments).toHaveBeenCalledWith(CO, filters, 'supplier');
    expect(listSupplierPayments).not.toHaveBeenCalled();
    expect(body).toMatchObject({ detail: 'summary', group_by: 'supplier' });
    await listSupplierPaymentsTool.handler({ detail: 'summary' }, ctx);
    expect(summariseSupplierPayments).toHaveBeenLastCalledWith(
      CO, { supplierId: null, status: null, fromDate: null, toDate: null, search: null }, null,
    );
  });

  it('refuses what a summary cannot take, and still validates the filters first', async () => {
    expect(fails(await listSupplierPaymentsTool.handler({ detail: 'summary', offset: 1 }, ctx))).toContain('omit cursor and offset');
    expect(fails(await listSupplierPaymentsTool.handler({ group_by: 'bank' }, ctx))).toContain('group_by must be one of: supplier, status, month');
    expect(fails(await listSupplierPaymentsTool.handler({ detail: 'summary', status: 'bogus' }, ctx))).toContain('status must be one of');
    expect(fails(await listSupplierPaymentsTool.handler({ detail: 'summary', from_date: '2026-05-01', to_date: '2026-01-01' }, ctx))).toContain('from_date');
    expect(summariseSupplierPayments).not.toHaveBeenCalled();
  });
});

describe('list_documents', () => {
  const att = (i: number) => ({
    id: `a${i}`, store: 'bank_attachment', bankTransactionId: TX, fileName: 'f.pdf', fileSize: 1, uploadedBy: null,
    createdAt: '2026-09-01T00:00:00.000Z', transactionDate: '2026-09-01', amount: -1, transactionDescription: 'd', reference: null,
  });
  const window = { from: '2026-01-01', to: '2026-12-31' };

  it('the bank store takes an offset, passes it to the service and answers next_offset', async () => {
    vi.mocked(listBankAttachments).mockResolvedValue({ rows: [att(1), att(2)], rowsTotal: 9, postedThrough: '2026-09-01T00:00:00.000Z' });
    const body = parse(await listDocumentsTool.handler({ ...window, limit: 2, offset: 4, bank_transaction_id: TX }, ctx));
    expect(listBankAttachments).toHaveBeenCalledWith(CO, { ...window, bankTransactionId: TX, limit: 2, offset: 4 });
    expect(body.next_offset).toBe(6);
    expect(body.rowsTotal).toBe(9);
    vi.mocked(listBankAttachments).mockResolvedValue({ rows: [att(1)], rowsTotal: 9, postedThrough: '2026-09-01T00:00:00.000Z' });
    expect(parse(await listDocumentsTool.handler({ ...window, limit: 2, offset: 8 }, ctx)).next_offset).toBeNull();
  });

  it('a default bank-store call is unchanged: limit 50, offset 0, no summary service', async () => {
    vi.mocked(listBankAttachments).mockResolvedValue({ rows: [], rowsTotal: 0, postedThrough: '2026-09-01T00:00:00.000Z' });
    await listDocumentsTool.handler(window, ctx);
    expect(listBankAttachments).toHaveBeenCalledWith(CO, { ...window, limit: 50, offset: 0 });
    expect(summariseBankAttachments).not.toHaveBeenCalled();
  });

  it('the entity store: next_offset advances by the limit, whichever side has more', async () => {
    vi.mocked(listEntityDocuments).mockResolvedValue({ ok: true, hasMore: true, documents: [] });
    const entity = { entity_type: 'supplier_invoice', entity_id: SUP };
    expect(parse(await listDocumentsTool.handler({ ...entity, limit: 10, offset: 20 }, ctx)).next_offset).toBe(30);
    expect(listEntityDocuments).toHaveBeenCalledWith(CO, 'supplier_invoice', SUP, 10, 20);
    vi.mocked(listEntityDocuments).mockResolvedValue({ ok: true, hasMore: false, documents: [] });
    expect(parse(await listDocumentsTool.handler(entity, ctx)).next_offset).toBeNull();
  });

  it('a bank line as entity pages too', async () => {
    vi.mocked(listBankAttachments).mockResolvedValue({ rows: [att(1)], rowsTotal: 3, postedThrough: '2026-09-01T00:00:00.000Z' });
    const body = parse(await listDocumentsTool.handler({ entity_type: 'bank_transaction', entity_id: TX, limit: 1, offset: 1 }, ctx));
    expect(listBankAttachments).toHaveBeenCalledWith(CO, { bankTransactionId: TX, limit: 1, offset: 1 });
    expect(body.next_offset).toBe(2);
  });

  it('a summary totals the bank window with the same filters and takes no offset', async () => {
    const body = parse(await listDocumentsTool.handler({ ...window, bank_transaction_id: TX, group_by: 'month' }, ctx));
    expect(summariseBankAttachments).toHaveBeenCalledWith(CO, { ...window, bankTransactionId: TX }, 'month');
    expect(listBankAttachments).not.toHaveBeenCalled();
    expect(body).toMatchObject({ detail: 'summary', group_by: 'month', from: window.from, to: window.to });
    expect(fails(await listDocumentsTool.handler({ ...window, detail: 'summary', offset: 1 }, ctx))).toContain('omit cursor and offset');
    expect(fails(await listDocumentsTool.handler({ ...window, group_by: 'type' }, ctx))).toContain('group_by must be one of: store, month');
  });

  it('a summary of the entity store is refused, not faked', async () => {
    const text = fails(await listDocumentsTool.handler({ entity_type: 'supplier_invoice', entity_id: SUP, detail: 'summary' }, ctx));
    expect(text).toContain('bank store');
    expect(listEntityDocuments).not.toHaveBeenCalled();
    expect(summariseBankAttachments).not.toHaveBeenCalled();
  });

  it('a summary still needs the bank-tx scope the bank store needs', async () => {
    const noBank = { ...ctx, scopes: ['read:reports'] };
    expect(fails(await listDocumentsTool.handler({ ...window, detail: 'summary' }, noBank))).toContain('read:bank-tx');
    expect(summariseBankAttachments).not.toHaveBeenCalled();
  });
});

describe('list_bank_rules', () => {
  const mk = (i: number, over: Record<string, unknown> = {}) => ({
    id: `r${String(i).padStart(3, '0')}`, ruleName: `Rule ${i}`, isActive: true, autoCreateEntry: i % 2 === 0, matchField: 'description',
    matchType: 'contains', matchPattern: `pat${i}`, priority: i, vatCode: 'none', glAccountId: i < 100 ? 'acc-1' : 'acc-2', autoApply: 'fifo', ...over,
  });
  const book = Array.from({ length: 150 }, (_, i) => mk(i));

  it('pages the filtered set; total and auto_posting_rules are over the WHOLE set, not the page', async () => {
    vi.mocked(getRules).mockResolvedValue(book as never);
    const first = parse(await listBankRulesTool.handler({}, ctx));
    expect(first.rules).toHaveLength(75);
    expect(first.total).toBe(150);
    expect(first.auto_posting_rules).toBe(75);
    expect(first.next_offset).toBe(75);
    const second = parse(await listBankRulesTool.handler({ offset: 75 }, ctx));
    expect(second.rules).toHaveLength(75);
    expect(second.next_offset).toBeNull();
    expect(second.auto_posting_rules).toBe(75);
    const ids = [...(first.rules as Array<{ id: string }>), ...(second.rules as Array<{ id: string }>)].map((r) => r.id);
    expect(new Set(ids).size).toBe(150);
  });

  it('filters apply before the page is cut, and a small set comes back whole', async () => {
    vi.mocked(getRules).mockResolvedValue(book as never);
    const body = parse(await listBankRulesTool.handler({ account_id: '55555555-5555-4555-8555-555555555555' }, ctx));
    expect(body.total).toBe(0);
    vi.mocked(getRules).mockResolvedValue(book.slice(0, 3) as never);
    const small = parse(await listBankRulesTool.handler({}, ctx));
    expect(small.rules).toHaveLength(3);
    expect(small.next_offset).toBeNull();
    expect(Object.keys(small).sort()).toEqual(['auto_posting_rules', 'next_offset', 'rules', 'total']);
  });

  it('an offset past the end is an empty last page; a bad offset or limit is refused or clamped', async () => {
    vi.mocked(getRules).mockResolvedValue(book as never);
    const past = parse(await listBankRulesTool.handler({ offset: 500 }, ctx));
    expect(past.rules).toEqual([]);
    expect(past.next_offset).toBeNull();
    expect(past.total).toBe(150);
    expect(fails(await listBankRulesTool.handler({ offset: 1.5 }, ctx))).toContain('offset must be an integer');
    expect(parse(await listBankRulesTool.handler({ limit: 9999 }, ctx)).rules).toHaveLength(75);
    expect(parse(await listBankRulesTool.handler({ limit: 5 }, ctx)).rules).toHaveLength(5);
  });
});

describe('list_work_items', () => {
  const items = Array.from({ length: 700 }, (_, i) => ({ id: `w${i}`, categoryId: 'c', name: `Item ${i}`, isActive: true, defaultBillable: true }));

  it('passes its filters to the service, pages the result and reports the whole match count', async () => {
    vi.mocked(listWorkItems).mockResolvedValue(items as never);
    const cat = '66666666-6666-4666-8666-666666666666';
    const first = parse(await listWorkItemsTool.handler({ category_id: cat, include_inactive: true }, ctx));
    expect(listWorkItems).toHaveBeenCalledWith(CO, cat, true);
    expect(first.work_items).toHaveLength(200);
    expect(first.total).toBe(700);
    expect(first.next_offset).toBe(200);
    const last = parse(await listWorkItemsTool.handler({ offset: 600, limit: 300 }, ctx));
    expect(last.work_items).toHaveLength(100);
    expect(last.next_offset).toBeNull();
  });

  it('total 0 is still the "no work items" signal, and a small set is whole', async () => {
    vi.mocked(listWorkItems).mockResolvedValue([]);
    expect(parse(await listWorkItemsTool.handler({}, ctx))).toEqual({ total: 0, next_offset: null, work_items: [] });
    vi.mocked(listWorkItems).mockResolvedValue(items.slice(0, 4) as never);
    const small = parse(await listWorkItemsTool.handler({}, ctx));
    expect(small.work_items).toHaveLength(4);
    expect(small.next_offset).toBeNull();
  });

  it('refuses a bad offset', async () => {
    expect(fails(await listWorkItemsTool.handler({ offset: -3 }, ctx))).toContain('offset must be an integer');
    expect(listWorkItems).not.toHaveBeenCalled();
  });
});
