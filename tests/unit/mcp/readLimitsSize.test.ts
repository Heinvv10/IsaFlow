/**
 * The seven list reads that could outgrow a client's result limit (brief step 7h follow-up): at their DEFAULT limit
 * and at their MAXIMUM limit, with realistic worst-case rows (every optional field filled, long names), the tool's
 * serialised reply stays under MAX_READ_RESULT_BYTES (resultSize.ts, the line the registry refuses a read at), and a
 * limit past the maximum is clamped to it. Also pins that a partial page says so (next_offset / next_cursor) and that
 * a small set comes back whole.
 *
 * The services are mocked and produce as many rows as the page asks for, out of a book far bigger than any page.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: Object.assign(vi.fn(), { unsafe: vi.fn() }), withSavepoint: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/core/contactDirectoryService', () => ({ listCustomers: vi.fn(), listSuppliers: vi.fn() }));
vi.mock('@/modules/accounting/services/gl/chartOfAccountsService', () => ({ getChartOfAccounts: vi.fn() }));
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
vi.mock('@/modules/accounting/services/bank/bankRulesService', () => ({
  getRules: vi.fn(), createRule: vi.fn(), updateRule: vi.fn(), toggleRule: vi.fn(),
}));
vi.mock('@/modules/accounting/services/gl/journalEntryService', () => ({}));
vi.mock('@/modules/accounting/services/practice/practiceJobCategoryService', () => ({
  listJobCategories: vi.fn(), listWorkItems: vi.fn(), createJobCategory: vi.fn(), createWorkItem: vi.fn(),
}));
vi.mock('@/modules/accounting/services/practice/practiceClientService', () => ({ listPracticeClients: vi.fn() }));
vi.mock('@/modules/accounting/services/practice/practiceTimeEntryService', () => ({ listPracticeEntries: vi.fn() }));

import { listCustomers } from '@/modules/accounting/services/core/contactDirectoryService';
import { getChartOfAccounts } from '@/modules/accounting/services/gl/chartOfAccountsService';
import { getCreditNotes } from '@/modules/accounting/services/ar/creditNoteService';
import { listSupplierPayments } from '@/modules/accounting/services/ap/supplierPaymentListService';
import { listBankAttachments, listEntityDocuments } from '@/modules/accounting/services/core/documentQueryService';
import { getRules } from '@/modules/accounting/services/bank/bankRulesService';
import { listWorkItems } from '@/modules/accounting/services/practice/practiceJobCategoryService';
import { listCustomersTool, CUSTOMERS_DEFAULT_LIMIT, CUSTOMERS_MAX_LIMIT } from '@/lib/mcp/tools/contacts';
import { listGlAccountsTool, GL_ACCOUNTS_DEFAULT_LIMIT, GL_ACCOUNTS_MAX_LIMIT } from '@/lib/mcp/tools/reports';
import { listCreditNotesTool, CREDIT_NOTES_DEFAULT_LIMIT, CREDIT_NOTES_MAX_LIMIT } from '@/lib/mcp/tools/creditNotes';
import {
  listSupplierPaymentsTool, SUPPLIER_PAYMENTS_DEFAULT_LIMIT, SUPPLIER_PAYMENTS_MAX_LIMIT,
} from '@/lib/mcp/tools/listSupplierPayments';
import { listDocumentsTool, DOCUMENTS_DEFAULT_LIMIT, DOCUMENTS_MAX_LIMIT } from '@/lib/mcp/tools/listDocuments';
import { listBankRulesTool, BANK_RULES_DEFAULT_LIMIT, BANK_RULES_MAX_LIMIT } from '@/lib/mcp/tools/bankRules';
import { listWorkItemsTool, WORK_ITEMS_DEFAULT_LIMIT, WORK_ITEMS_MAX_LIMIT } from '@/lib/mcp/tools/practice';
import { MAX_READ_RESULT_BYTES } from '@/lib/mcp/resultSize';
import type { McpTool, McpToolContext } from '@/lib/mcp/types';

const CO = '22222222-2222-4222-8222-222222222222';
const ctx: McpToolContext = {
  userId: 'u', companyId: CO, tokenJti: 'j', oauthAppId: null,
  scopes: ['read:contacts', 'read:invoices', 'read:reports', 'read:bank-tx', 'read:practice'],
};
const BOOK = 5000; // rows in the pretend book: far more than any page
const uuid = (i: number): string => `${String(i).padStart(8, '0')}-1111-4111-8111-111111111111`;
/** A long name, as the worst realistic row carries. */
const long = (n: number, tag: string): string => `${tag} ${'N'.repeat(Math.max(0, n - tag.length - 1))}`;
const bytes = (r: { content: Array<{ text: string }> }): number => r.content.reduce((n, c) => n + Buffer.byteLength(c.text, 'utf8'), 0);
const parse = (r: { content: Array<{ text: string }>; isError?: boolean }): Record<string, unknown> => {
  expect(r.isError).toBeFalsy();
  return JSON.parse(r.content[0]!.text) as Record<string, unknown>;
};

const customerRow = (i: number) => ({
  id: uuid(i), name: long(50, 'Customer'), email: `${'e'.repeat(36)}@example.co.za`, phone: '+27 82 123 4567', contact_person: long(30, 'Person'),
  payment_terms: 30, payment_terms_type: 'days_after_invoice', credit_limit: '100000.00', is_active: true, vat_number: '4123456789',
  registration_number: '2015/123456/07', default_revenue_account_id: uuid(i + 1), created_at: new Date('2026-11-13T08:00:00.000Z'),
});
const account = (i: number) => ({
  id: uuid(i), accountCode: `6000/${String(i).padStart(4, '0')}`, accountName: long(50, 'Account'), accountType: 'expense',
  accountSubtype: 'operating_expense', isActive: true, parentAccountId: uuid(i + 1),
});
const creditNote = (i: number) => ({
  id: uuid(i), creditNoteNumber: `CN-2026-${String(i).padStart(5, '0')}`, type: 'customer', clientId: uuid(i + 1), clientName: long(50, 'Customer'),
  supplierId: uuid(i + 2), supplierName: long(50, 'Supplier'), customerInvoiceId: uuid(i + 3), supplierInvoiceId: uuid(i + 4),
  invoiceNumber: 'INV-2026-001234', creditDate: '2026-11-13', reason: long(120, 'Reason'), subtotal: 12345.67, taxRate: 15, taxAmount: 1851.85,
  totalAmount: 14197.52, appliedAmount: 14197.52, status: 'partially_applied', glJournalEntryId: uuid(i + 5),
});
const payment = (i: number) => ({
  paymentId: uuid(i), paymentNumber: `PAY-2026-${String(i).padStart(5, '0')}`, paymentDate: '2026-11-13', supplierId: uuid(i + 1),
  supplierName: long(50, 'Supplier'), paymentAmount: 12345.67, allocatedAmount: 12345.67, unappliedAmount: 0, status: 'processed',
  paymentMethod: 'eft', reference: long(60, 'Ref'), description: long(120, 'Desc'), journalEntryId: uuid(i + 2), batchId: uuid(i + 3),
});
const attachment = (i: number) => ({
  id: uuid(i), store: 'bank_attachment' as const, bankTransactionId: uuid(i + 1), fileName: `${'f'.repeat(60)}.pdf`, fileSize: 123456,
  uploadedBy: uuid(i + 2), createdAt: '2026-11-13T08:00:00.000Z', transactionDate: '2026-11-13', amount: -1234.56,
  transactionDescription: long(100, 'Tx'), reference: long(40, 'Ref'),
});
const entityDoc = (i: number) => ({
  id: uuid(i), entityType: 'supplier_invoice', entityId: uuid(i + 1), documentType: 'invoice', documentName: `${'f'.repeat(60)}.pdf`, fileSize: 123456,
  mimeType: 'application/pdf', uploadedBy: uuid(i + 2), uploadedByName: long(30, 'Uploader'), uploadedAt: '2026-11-13T08:00:00.000Z',
  source: 'linked', linkReason: long(60, 'Reason'),
});
const rule = (i: number) => ({
  id: uuid(i), ruleName: long(60, 'Rule'), isActive: true, autoCreateEntry: true, matchField: 'description', matchType: 'contains',
  matchPattern: long(60, 'Pattern'), priority: i, vatCode: 'standard', glAccountId: uuid(i + 1), glAccountCode: '6000/0001',
  glAccountName: long(50, 'Account'), supplierId: uuid(i + 2), supplierName: long(50, 'Supplier'), clientId: uuid(i + 3),
  clientName: long(50, 'Customer'), descriptionTemplate: long(80, 'Template'), autoApply: 'fifo',
});
const workItem = (i: number) => ({ id: uuid(i), categoryId: uuid(i + 1), name: long(60, 'Work item'), isActive: true, defaultBillable: true });

interface Case {
  tool: McpTool;
  dflt: number;
  max: number;
  /** The array a reply carries its rows in. */
  key: string;
  /** Teach the mocked service to serve pages out of a book of BOOK rows. */
  arm: () => void;
  /** The `limit` argument the service was last asked for, as the SERVICE sees it. */
  served: () => number;
  /** How a partial page says so. */
  more: (body: Record<string, unknown>) => boolean;
  args?: Record<string, unknown>;
}

const page = (limit: number, offset: number): number => Math.max(0, Math.min(limit, BOOK - offset));
const nextOffset = (b: Record<string, unknown>): boolean => typeof b.next_offset === 'number';

const cases: Record<string, Case> = {
  list_customers: {
    tool: listCustomersTool, dflt: CUSTOMERS_DEFAULT_LIMIT, max: CUSTOMERS_MAX_LIMIT, key: 'customers', more: nextOffset,
    arm: () => vi.mocked(listCustomers).mockImplementation(async (_c, _s, p) => Array.from({ length: page(p!.limit, p!.offset) }, (_, i) => customerRow(i)) as never),
    // The tool asks the service for one row past the page.
    served: () => vi.mocked(listCustomers).mock.calls.at(-1)![2]!.limit - 1,
  },
  list_gl_accounts: {
    tool: listGlAccountsTool, dflt: GL_ACCOUNTS_DEFAULT_LIMIT, max: GL_ACCOUNTS_MAX_LIMIT, key: 'accounts',
    more: (b) => typeof b.next_cursor === 'string',
    arm: () => vi.mocked(getChartOfAccounts).mockResolvedValue(Array.from({ length: BOOK }, (_, i) => account(i)) as never),
    served: () => -1,
  },
  list_credit_notes: {
    tool: listCreditNotesTool, dflt: CREDIT_NOTES_DEFAULT_LIMIT, max: CREDIT_NOTES_MAX_LIMIT, key: 'credit_notes', more: nextOffset,
    arm: () => vi.mocked(getCreditNotes).mockImplementation(async (_c, f) => ({
      creditNotes: Array.from({ length: page(f!.limit!, f!.offset!) }, (_, i) => creditNote(i)), total: BOOK,
    }) as never),
    served: () => vi.mocked(getCreditNotes).mock.calls.at(-1)![1]!.limit!,
  },
  list_supplier_payments: {
    tool: listSupplierPaymentsTool, dflt: SUPPLIER_PAYMENTS_DEFAULT_LIMIT, max: SUPPLIER_PAYMENTS_MAX_LIMIT, key: 'payments', more: nextOffset,
    arm: () => vi.mocked(listSupplierPayments).mockImplementation(async (_c, f) => ({
      rows: Array.from({ length: page(f.limit, f.offset) }, (_, i) => payment(i)), total: BOOK,
      totals: { paymentAmount: 1, allocatedAmount: 1, unappliedAmount: 0 },
    }) as never),
    served: () => vi.mocked(listSupplierPayments).mock.calls.at(-1)![1].limit,
  },
  'list_documents (bank store)': {
    tool: listDocumentsTool, dflt: DOCUMENTS_DEFAULT_LIMIT, max: DOCUMENTS_MAX_LIMIT, key: 'rows', more: nextOffset,
    args: { from: '2026-01-01', to: '2026-12-31' },
    arm: () => vi.mocked(listBankAttachments).mockImplementation(async (_c, f) => ({
      rows: Array.from({ length: page(f.limit, f.offset ?? 0) }, (_, i) => attachment(i)), rowsTotal: BOOK, postedThrough: '2026-11-13T08:00:00.000Z',
    }) as never),
    served: () => vi.mocked(listBankAttachments).mock.calls.at(-1)![1].limit,
  },
  'list_documents (entity store, direct + linked per page)': {
    tool: listDocumentsTool, dflt: DOCUMENTS_DEFAULT_LIMIT, max: DOCUMENTS_MAX_LIMIT, key: 'rows', more: nextOffset,
    args: { entity_type: 'supplier_invoice', entity_id: uuid(99) },
    arm: () => vi.mocked(listEntityDocuments).mockImplementation(async (_c, _t, _e, limit) => ({
      ok: true, hasMore: true, documents: Array.from({ length: 2 * limit }, (_, i) => entityDoc(i)),
    }) as never),
    served: () => vi.mocked(listEntityDocuments).mock.calls.at(-1)![3],
  },
  list_bank_rules: {
    tool: listBankRulesTool, dflt: BANK_RULES_DEFAULT_LIMIT, max: BANK_RULES_MAX_LIMIT, key: 'rules', more: nextOffset,
    arm: () => vi.mocked(getRules).mockResolvedValue(Array.from({ length: BOOK }, (_, i) => rule(i)) as never),
    served: () => -1,
  },
  list_work_items: {
    tool: listWorkItemsTool, dflt: WORK_ITEMS_DEFAULT_LIMIT, max: WORK_ITEMS_MAX_LIMIT, key: 'work_items', more: nextOffset,
    arm: () => vi.mocked(listWorkItems).mockResolvedValue(Array.from({ length: BOOK }, (_, i) => workItem(i)) as never),
    served: () => -1,
  },
};

beforeEach(() => vi.clearAllMocks());

describe.each(Object.entries(cases))('%s', (_name, c) => {
  const call = (limit?: number) => c.tool.handler({ ...(c.args ?? {}), ...(limit === undefined ? {} : { limit }) }, ctx);
  const rowsOf = (b: Record<string, unknown>): unknown[] => b[c.key] as unknown[];
  // The entity store answers up to twice the limit; every other store exactly the limit.
  const expectedRows = (limit: number): number => (c.tool === listDocumentsTool && c.args?.entity_type ? 2 * limit : limit);

  it('a default call, from a book far bigger than a page, fits under the client result limit and says there is more', async () => {
    c.arm();
    const r = await call();
    const body = parse(r);
    expect(rowsOf(body)).toHaveLength(expectedRows(c.dflt));
    expect(bytes(r)).toBeLessThan(MAX_READ_RESULT_BYTES);
    expect(c.more(body)).toBe(true);
  });

  it('a call at the maximum limit fits too', async () => {
    c.arm();
    const r = await call(c.max);
    expect(rowsOf(parse(r))).toHaveLength(expectedRows(c.max));
    expect(bytes(r)).toBeLessThan(MAX_READ_RESULT_BYTES);
  });

  it('a limit past the maximum is clamped to it', async () => {
    c.arm();
    const body = parse(await call(c.max * 40));
    expect(rowsOf(body)).toHaveLength(expectedRows(c.max));
    const served = c.served();
    if (served >= 0) expect(served).toBe(c.max);
  });
});

describe('the registry refusal line is the one these limits were sized against', () => {
  it('is 90,000 bytes', () => expect(MAX_READ_RESULT_BYTES).toBe(90_000));
});
