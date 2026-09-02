/**
 * Every MCP tool argument that lands in a SQL cast, refused before it gets there.
 *
 * The failure this prevents: an agent's id becomes `$n::UUID` and its date
 * `$n::DATE`, so 'abc' is a 22P02 and 'junk' / '2026-02-31' a 22008. A READ
 * tool runs with NO savepoint (registry.ts), so the error aborts the whole
 * request transaction — the registry's own refund and audit writes then fail
 * with 25P02, and the caller gets a 500 with the Flow debit unrefunded. A
 * WRITE tool has a savepoint and survives, but the reply degrades to a generic
 * failure naming no argument.
 *
 * `format: date` in a JSON Schema is advisory; nothing here enforces it. So
 * these guards are the only thing between an agent's typo and the cast, and
 * the assertion that matters is not the message — it is that the service was
 * never called and NO query was issued.
 *
 * Services are mocked at the module boundary: if a guard is missing, the mock
 * records a call and the test fails. That is the mutation-detectable signal.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/neon')>();
  const sqlFn = Object.assign(vi.fn().mockResolvedValue([]), {
    transaction: vi.fn(),
    unsafe: vi.fn((s: string) => s),
  });
  return {
    sql: sqlFn,
    fmtDate: actual.fmtDate,
    withTransaction: vi.fn((cb: (tx: typeof sqlFn) => unknown) => cb(sqlFn)),
  };
});
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/modules/accounting/services/gl/trialBalanceService', () => ({ getTrialBalance: vi.fn() }));
vi.mock('@/modules/accounting/services/gl/fiscalPeriodService', () => ({ getFiscalPeriodIdForDate: vi.fn() }));
vi.mock('@/modules/accounting/services/reports/incomeStatementService', () => ({ getIncomeStatement: vi.fn() }));
vi.mock('@/modules/accounting/services/reports/balanceSheetService', () => ({ getBalanceSheet: vi.fn() }));
vi.mock('@/modules/accounting/services/ar/arAgingService', () => ({ getARAging: vi.fn() }));
vi.mock('@/modules/accounting/services/ap/apAgingService', () => ({ getAPAging: vi.fn() }));
vi.mock('@/modules/accounting/services/reports/accountLedgerService', () => ({ getAccountLedger: vi.fn() }));
vi.mock('@/modules/accounting/services/ar/customerInvoiceReadService', () => ({
  listCustomerInvoices: vi.fn(),
  getCustomerInvoiceDetail: vi.fn(),
}));
vi.mock('@/modules/accounting/services/reports/vatReturnService', () => ({ getVATReturn: vi.fn() }));
vi.mock('@/modules/accounting/services/bank/bankMatchCandidatesService', () => ({ getMatchCandidates: vi.fn() }));
vi.mock('@/modules/accounting/services/bank/agentActivityService', () => ({ listAgentPostings: vi.fn() }));
vi.mock('@/modules/accounting/services/bank/bankTransactionQueryService', () => ({ getBankTransactions: vi.fn() }));
vi.mock('@/modules/accounting/services/bank/bankAccountStatusService', () => ({ getBankAccountsStatus: vi.fn() }));
vi.mock('@/modules/accounting/services/core/smartCategorizationService', () => ({ bulkCategorize: vi.fn() }));
vi.mock('@/modules/accounting/services/bank/bankAllocationRangeService', () => ({
  findAllocatedInRange: vi.fn(),
  countAllocatedInRange: vi.fn(async () => 0),
}));
vi.mock('@/modules/accounting/services/bank/bankOpeningBalanceService', () => ({
  setBankOpeningBalanceMeta: { read: vi.fn(async () => ({ amount: null, asAt: null })), write: vi.fn() },
}));
vi.mock('@/modules/accounting/services/bank/bankRulesService', () => ({
  getRules: vi.fn(async () => []),
  createRule: vi.fn(),
  updateRule: vi.fn(),
  toggleRule: vi.fn(),
}));
vi.mock('@/modules/accounting/services/ap/supplierInvoiceService', () => ({
  getSupplierInvoices: vi.fn(),
  getSupplierInvoiceById: vi.fn(),
  createSupplierInvoice: vi.fn(),
}));

import {
  getSupplierInvoices,
  getSupplierInvoiceById,
} from '@/modules/accounting/services/ap/supplierInvoiceService';
import { getTrialBalance } from '@/modules/accounting/services/gl/trialBalanceService';
import { getIncomeStatement } from '@/modules/accounting/services/reports/incomeStatementService';
import { getBalanceSheet } from '@/modules/accounting/services/reports/balanceSheetService';
import { getARAging } from '@/modules/accounting/services/ar/arAgingService';
import { getAPAging } from '@/modules/accounting/services/ap/apAgingService';
import { getAccountLedger } from '@/modules/accounting/services/reports/accountLedgerService';
import {
  listCustomerInvoices,
  getCustomerInvoiceDetail,
} from '@/modules/accounting/services/ar/customerInvoiceReadService';
import { getVATReturn } from '@/modules/accounting/services/reports/vatReturnService';
import { getMatchCandidates } from '@/modules/accounting/services/bank/bankMatchCandidatesService';
import { listAgentPostings } from '@/modules/accounting/services/bank/agentActivityService';
import { getBankTransactions } from '@/modules/accounting/services/bank/bankTransactionQueryService';
import { bulkCategorize } from '@/modules/accounting/services/core/smartCategorizationService';

import { sql } from '@/lib/neon';
import { MCP_TOOLS } from '@/lib/mcp/toolIndex';
import type { McpTool, McpToolContext } from '@/lib/mcp/types';

const COMPANY_ID = '22222222-2222-2222-2222-222222222222';
const UUID2 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const UUID = '11111111-1111-4111-8111-111111111111';
const KEY = { idempotency_key: 'idem-1' };

function ctx(): McpToolContext {
  return {
    userId: 'user-1',
    companyId: COMPANY_ID,
    scopes: ['read:reports', 'read:invoices', 'read:contacts', 'read:bank-tx', 'read:vat',
      'write:bank-tx', 'write:invoices', 'write:journals'],
    tokenJti: 'jti-1',
    oauthAppId: null,
  };
}

function tool(name: string): McpTool {
  const t = MCP_TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`tool not registered: ${name}`);
  return t;
}

/** Every service any guarded tool would reach. None may be called. */
const SERVICES = [
  getTrialBalance, getIncomeStatement, getBalanceSheet, getARAging, getAPAging,
  getAccountLedger, listCustomerInvoices, getCustomerInvoiceDetail, getVATReturn,
  getMatchCandidates, listAgentPostings, getBankTransactions,
  getSupplierInvoices, getSupplierInvoiceById,
];

// [tool, args, the argument expected to be named]
const BAD_UUID: Array<[string, Record<string, unknown>, string]> = [
  ['trial_balance', { fiscal_period_id: 'abc' }, 'fiscal_period_id'],
  ['search_gl', { account_id: 'abc', from_date: '2026-01-01', to_date: '2026-06-30' }, 'account_id'],
  ['list_invoices', { customer_id: 'not-a-uuid' }, 'customer_id'],
  ['get_invoice', { invoice_id: 'abc' }, 'invoice_id'],
  ['get_match_candidates', { transaction_id: "1' OR '1'='1" }, 'transaction_id'],
  ['list_bank_transactions', { bank_account_id: 'abc' }, 'bank_account_id'],
  ['list_supplier_invoices', { supplier_id: 'abc' }, 'supplier_id'],
  ['get_supplier_invoice', { invoice_id: "1' OR '1'='1" }, 'invoice_id'],
  ['list_bank_rules', { account_id: 'abc' }, 'account_id'],
  ['get_bank_rule', { rule_id: "1' OR '1'='1" }, 'rule_id'],
];

const BAD_DATE: Array<[string, Record<string, unknown>, string]> = [
  ['profit_and_loss', { period_start: 'junk', period_end: '2026-06-30' }, 'period_start'],
  ['profit_and_loss', { period_start: '2026-01-01', period_end: '2026-02-31' }, 'period_end'],
  ['balance_sheet', { as_at: 'yesterday' }, 'as_at'],
  ['aged_debtors', { as_at: '2026-13-01' }, 'as_at'],
  ['aged_creditors', { as_at: '0000-01-01' }, 'as_at'],
  ['search_gl', { account_code: '1000', from_date: '2026-02-31', to_date: '2026-06-30' }, 'from_date'],
  ['vat_status', { period_start: '2026-05-01', period_end: 'junk' }, 'period_end'],
  ['list_agent_postings', { from: '2026-02-31', to: '2026-08-31' }, 'from'],
  ['list_bank_transactions', { to_date: '2026-02-29' }, 'to_date'],
  ['list_supplier_invoices', { from_date: '2026-02-31' }, 'from_date'],
  ['list_supplier_invoices', { to_date: 'yesterday' }, 'to_date'],
];

describe('read tools — an uncastable argument never reaches the service', () => {
  beforeEach(() => vi.clearAllMocks());

  for (const [name, args, argName] of [...BAD_UUID, ...BAD_DATE]) {
    it(`${name} refuses ${argName}=${JSON.stringify(args[argName])}`, async () => {
      const r = await tool(name).handler(args, ctx());

      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toBe(`invalid ${argName}`);
      // The guard's whole purpose: nothing downstream ran.
      for (const service of SERVICES) expect(vi.mocked(service)).not.toHaveBeenCalled();
      expect(vi.mocked(sql)).not.toHaveBeenCalled();
      // No internals in the reply.
      expect(r.content[0]!.text).not.toMatch(/22P02|22008|::|SELECT|_id =/);
    });
  }

  it('valid arguments still reach the service', async () => {
    vi.mocked(getAccountLedger).mockResolvedValue({ rows: [] } as never);
    const r = await tool('search_gl').handler(
      { account_id: UUID, from_date: '2026-01-01', to_date: '2028-02-29' }, ctx(),
    );
    expect(r.isError).toBeUndefined();
    expect(getAccountLedger).toHaveBeenCalled();
  });

  it('an absent optional argument is not an invalid one', async () => {
    vi.mocked(getARAging).mockResolvedValue([] as never);
    const r = await tool('aged_debtors').handler({}, ctx());
    expect(r.isError).toBeUndefined();
  });

  it('account_code stays free-form — it is compared as TEXT, not cast', async () => {
    vi.mocked(getAccountLedger).mockResolvedValue({ rows: [] } as never);
    const r = await tool('search_gl').handler(
      { account_code: '1000/A-B', from_date: '2026-01-01', to_date: '2026-06-30' }, ctx(),
    );
    expect(r.isError).toBeUndefined();
  });

  it('list_agent_postings still reports a MISSING date distinctly from an invalid one', async () => {
    const missing = await tool('list_agent_postings').handler({ to: '2026-08-31' }, ctx());
    expect(missing.content[0]!.text).toContain('required');
    const invalid = await tool('list_agent_postings').handler(
      { from: '2026-02-31', to: '2026-08-31' }, ctx(),
    );
    expect(invalid.content[0]!.text).toBe('invalid from');
  });
});

// Write tools have a savepoint, so a bad cast does not poison the transaction —
// but it still costs a round trip and returns a message that names nothing.
describe('write tools — an uncastable argument is named, not generic-ified', () => {
  beforeEach(() => vi.clearAllMocks());

  const WRITE_BAD: Array<[string, Record<string, unknown>, string]> = [
    ['create_draft_journal', {
      date: '2026-02-31',
      lines: [{ account_id: UUID, debit: 1, credit: 0 }, { account_id: UUID, debit: 0, credit: 1 }],
      ...KEY,
    }, 'date'],
    ['post_journal', { journal_id: 'abc', ...KEY }, 'journal_id'],
    ['allocate_bank_transaction', { transaction_id: 'abc', contra_account_id: UUID, ...KEY }, 'transaction_id'],
    ['allocate_bank_transaction', { transaction_id: UUID, contra_account_id: 'abc', ...KEY }, 'contra_account_id'],
    ['create_draft_invoice', {
      customer_id: 'abc', items: [{ description: 'x', unit_price: 1 }], ...KEY,
    }, 'customer_id'],
    ['create_draft_invoice', {
      customer_id: UUID, invoice_date: '2026-13-01',
      items: [{ description: 'x', unit_price: 1 }], ...KEY,
    }, 'invoice_date'],
    ['finalize_invoice', { invoice_id: 'abc', ...KEY }, 'invoice_id'],
    ['import_bank_statement', {
      bank_account_id: 'abc', file_type: 'csv', content: 'x', statement_date: '2026-04-30', ...KEY,
    }, 'bank_account_id'],
    ['undo_bank_import', { batch_id: 'abc', ...KEY }, 'batch_id'],
    // Chart of accounts. parent_account_id is the interesting one on both
    // tools: on create it is guarded by guardCastableArgs, on update it can
    // also arrive as an explicit null (a CLEAR), so its guard is separate and
    // could drift away from the shared one.
    ['create_gl_account', {
      account_code: '5900', account_name: 'X', account_type: 'expense',
      parent_account_id: 'abc', ...KEY,
    }, 'parent_account_id'],
    ['update_gl_account', { account_id: 'abc', account_name: 'X', ...KEY }, 'account_id'],
    ['update_gl_account', {
      account_id: UUID, parent_account_id: 'abc', ...KEY,
    }, 'parent_account_id'],
    ['deactivate_gl_account', { account_id: "1' OR '1'='1", ...KEY }, 'account_id'],
    // Supplier invoices (AP).
    ['create_supplier_invoice', {
      supplier_id: 'abc', invoice_number: 'INV-1', invoice_date: '2026-06-30',
      lines: [{ description: 'x', quantity: 1, unit_price: 1 }], ...KEY,
    }, 'supplier_id'],
    ['create_supplier_invoice', {
      supplier_id: UUID, invoice_number: 'INV-1', invoice_date: '2026-02-31',
      lines: [{ description: 'x', quantity: 1, unit_price: 1 }], ...KEY,
    }, 'invoice_date'],
    ['create_supplier_invoice', {
      supplier_id: UUID, invoice_number: 'INV-1', invoice_date: '2026-06-30',
      due_date: '2026-13-01',
      lines: [{ description: 'x', quantity: 1, unit_price: 1 }], ...KEY,
    }, 'due_date'],
    ['approve_supplier_invoice', { invoice_id: 'abc', ...KEY }, 'invoice_id'],
    // Bank rules. gl_account_id / supplier_id / client_id all become foreign
    // keys cast to ::UUID inside the ownership lookups, so each is guarded
    // before the query, not by it.
    ['create_bank_rule', {
      rule_name: 'R', match_field: 'description', match_type: 'contains',
      match_pattern: 'X', gl_account_id: 'abc', ...KEY,
    }, 'gl_account_id'],
    ['create_bank_rule', {
      rule_name: 'R', match_field: 'description', match_type: 'contains',
      match_pattern: 'X', supplier_id: 'abc', ...KEY,
    }, 'supplier_id'],
    ['create_bank_rule', {
      rule_name: 'R', match_field: 'description', match_type: 'contains',
      match_pattern: 'X', client_id: 'abc', ...KEY,
    }, 'client_id'],
    ['update_bank_rule', { rule_id: 'abc', ...KEY }, 'rule_id'],
    ['disable_bank_rule', { rule_id: 'abc', ...KEY }, 'rule_id'],
    // Range reversal: the account id and BOTH dates reach casts.
    ['reverse_allocations', {
      bank_account_id: 'abc', from_date: '2026-03-01', to_date: '2026-03-31', ...KEY,
    }, 'bank_account_id'],
    ['reverse_allocations', {
      bank_account_id: UUID, from_date: '2026-02-31', to_date: '2026-03-31', ...KEY,
    }, 'from_date'],
    ['reverse_allocations', {
      bank_account_id: UUID, from_date: '2026-03-01', to_date: 'yesterday', ...KEY,
    }, 'to_date'],
    ['set_opening_balance', {
      bank_account_id: 'abc', contra_account_id: UUID, as_at: '2026-03-01', amount: 1, ...KEY,
    }, 'bank_account_id'],
    ['set_opening_balance', {
      bank_account_id: UUID, contra_account_id: 'abc', as_at: '2026-03-01', amount: 1, ...KEY,
    }, 'contra_account_id'],
    ['set_opening_balance', {
      bank_account_id: UUID, contra_account_id: UUID2, as_at: '2026-13-01', amount: 1, ...KEY,
    }, 'as_at'],
    // Credit notes. Five arguments reach casts: the note id on approve/cancel,
    // and on create the counterparty id, either invoice id, and credit_date —
    // all of which land in ::UUID / ::DATE inside validateCreditNoteLinks or
    // the INSERT.
    ['create_credit_note', {
      type: 'customer', client_id: 'abc', credit_date: '2026-06-30', subtotal: 100, ...KEY,
    }, 'client_id'],
    ['create_credit_note', {
      type: 'supplier', supplier_id: 'abc', credit_date: '2026-06-30', subtotal: 100, ...KEY,
    }, 'supplier_id'],
    ['create_credit_note', {
      type: 'customer', client_id: UUID, customer_invoice_id: 'abc',
      credit_date: '2026-06-30', subtotal: 100, ...KEY,
    }, 'customer_invoice_id'],
    ['create_credit_note', {
      type: 'supplier', supplier_id: UUID, supplier_invoice_id: 'abc',
      credit_date: '2026-06-30', subtotal: 100, ...KEY,
    }, 'supplier_invoice_id'],
    ['create_credit_note', {
      type: 'customer', client_id: UUID, credit_date: '2026-02-31', subtotal: 100, ...KEY,
    }, 'credit_date'],
    ['approve_credit_note', { credit_note_id: 'abc', ...KEY }, 'credit_note_id'],
    ['cancel_credit_note', { credit_note_id: "1' OR '1'='1", ...KEY }, 'credit_note_id'],
  ];

  for (const [name, args, argName] of WRITE_BAD) {
    it(`${name} names ${argName}`, async () => {
      const r = await tool(name).handler(args, ctx());
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toBe(`invalid ${argName}`);
      expect(vi.mocked(sql)).not.toHaveBeenCalled();
    });
  }
});

// A list argument rejected as a whole ("invalid transaction_ids") leaves an
// agent to bisect 200 ids to find the one it typoed. The position and the
// value are the actionable part.
describe('list arguments — the offending element is named, not the array', () => {
  beforeEach(() => vi.clearAllMocks());

  it('suggest_bank_allocation names the index and the value', async () => {
    const r = await tool('suggest_bank_allocation').handler(
      { transaction_ids: [UUID, UUID, 'abc'], ...KEY }, ctx(),
    );
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toBe('invalid transaction_ids[2]: "abc"');
  });

  it('create_draft_journal names the line and the value', async () => {
    const r = await tool('create_draft_journal').handler({
      date: '2026-06-30',
      lines: [
        { account_id: UUID, debit: 1, credit: 0 },
        { account_id: 'not-a-uuid', debit: 0, credit: 1 },
      ],
      ...KEY,
    }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toBe('invalid lines[1].account_id: "not-a-uuid"');
  });

  it('reports the FIRST bad element', async () => {
    const r = await tool('suggest_bank_allocation').handler(
      { transaction_ids: ['first-bad', UUID, 'second-bad'], ...KEY }, ctx(),
    );
    expect(r.content[0]!.text).toBe('invalid transaction_ids[0]: "first-bad"');
  });

  // Indices must be those of the array the AGENT sent. Filtering the
  // non-strings out first would renumber everything after them and point the
  // agent at the wrong element.
  it('indexes against the original array, not a filtered copy', async () => {
    const r = await tool('suggest_bank_allocation').handler(
      { transaction_ids: [UUID, 42, 'abc'], ...KEY }, ctx(),
    );
    // The number at index 1 is itself invalid and reported there — not skipped,
    // which would have made the next failure read as index 1 instead of 2.
    expect(r.content[0]!.text).toBe('invalid transaction_ids[1]: "42"');
  });

  it('truncates a pathological value so it cannot bloat the reply', async () => {
    const huge = 'x'.repeat(5000);
    const r = await tool('suggest_bank_allocation').handler(
      { transaction_ids: [huge], ...KEY }, ctx(),
    );
    expect(r.content[0]!.text.length).toBeLessThan(120);
    expect(r.content[0]!.text).toContain('transaction_ids[0]');
    expect(r.content[0]!.text).toContain('…');
  });

  it('a fully valid list still reaches the service', async () => {
    vi.mocked(bulkCategorize).mockResolvedValue({ categorized: 2 } as never);
    const r = await tool('suggest_bank_allocation').handler(
      { transaction_ids: [UUID, UUID], ...KEY }, ctx(),
    );
    expect(r.isError).toBeUndefined();
    expect(bulkCategorize).toHaveBeenCalledWith(COMPANY_ID, [UUID, UUID]);
  });
});
