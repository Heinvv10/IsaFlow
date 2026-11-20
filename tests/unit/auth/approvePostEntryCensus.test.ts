/**
 * #1656, Hein 2026-11-19 ("gate everything"): every PERSON or TOKEN entry point that approves, posts or reverses asks
 * the module's Approve (User Access) before it writes. Two censuses pin it:
 *
 *  1. HTTP: every git-tracked pages/api file that calls one of POSTING_SERVICES carries an Approve gate
 *     (refuseWithoutApprove / mayApprove / assertMayApprove / mayApproveSupplierInvoices / assertMayApproveCreditNote /
 *     approveModuleForRequest), or is in EXEMPT_ROUTES with the reason. A new route calling a posting service without
 *     a gate fails here; so does an exemption whose file no longer calls the service (a stale pin).
 *  2. MCP: every tool that requires write:post, or whose name says it approves / posts / reverses, declares
 *     `approveModule` (the registry's module fence asks it before the handler), or is in EXEMPT_TOOLS with the reason.
 *
 * Out of scope, by ruling: system / cron runners (pages/api/cron/**, scheduled jobs, webhooks). They act for no
 * person, so there is no person's Approve to ask; their own gates (approval rules, unattended holds) still apply.
 * Known limit: the census is by file, not by call site — a gate on one action of a route covers the file. Each gate's
 * placement before the write is pinned by the per-path tests (approveGateEverything, breaker1670*, the integration
 * suite migration-1010-roles-and-permissions).
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { MCP_TOOLS } from '@/lib/mcp/toolIndex';

/** Services that approve, post, reverse or finalise a ledger document when a route calls them. */
const POSTING_SERVICES = [
  // GL / accounts
  'postJournalEntry', 'reverseJournalEntry', 'postOpeningBalances', 'executeMigration', 'runDepreciation',
  'closeFiscalYear', 'closePeriod', 'closeYear', 'lockPeriod', 'reopenPeriod', 'runBulkPeriodAction',
  'runRecurringJournal', 'postAssetDisposalToGL', 'postCapitalizationExpenseToGL', 'closeLoanPeriod',
  'postPeriodJournals', 'postEliminationAdjustment', 'reverseEliminationAdjustment',
  // AP
  'approveSupplierInvoice', 'cancelSupplierInvoice', 'postSupplierInvoiceToGL', 'approveSupplierPayment',
  'processSupplierPayment', 'voidSupplierPayment', 'approveBatch', 'processBatch', 'reverseBatch',
  'approveCreditNote', 'cancelCreditNote', 'approveClaim', 'postClaimToGl', 'postReceiptAsPettyCashJournal',
  'runCapturePostFollowUps', 'attachEvidenceAndSettleApproved',
  // AR
  'approveCustomerInvoice', 'cancelCustomerInvoice', 'postCustomerInvoiceToGL', 'confirmCustomerPayment',
  'cancelCustomerPayment', 'runRecurringInvoice', 'approveWriteOff',
  // banking
  'allocateTransaction', 'splitAllocateTransaction', 'bulkAcceptTransactions', 'reverseReconciledTransaction',
  'confirmBulkAccept', 'undoBulkAcceptBatch', 'confirmReceiptMatch', 'confirmCustomerInvoiceMatch',
  'confirmSupplierInvoiceMatch', 'confirmPurchaseOrderMatch', 'postBankTransfer', 'postProvisional',
  // VAT, items, practice, budgets, approvals
  'approveVATAdjustment', 'finaliseReturn', 'approveAdjustment', 'approveEntries', 'approvePracticeEntries',
  'transitionVersion', 'decideRequest', 'approvePurchaseOrder',
  // payroll
  'approvePayrollRun', 'reopenPayrollRun', 'postBatch', 'bookEtiForMonthLocked', 'markUifDeclarationPaid',
  // recurring templates (the run decides per template type)
  'executeRecurring',
] as const;

const GATE = /\b(refuseWithoutApprove|mayApprove|assertMayApprove|mayApproveSupplierInvoices|assertMayApproveCreditNote|approveModuleForRequest)\(/;

/** Routes that call a posting service without a route-level gate, and why that is right. */
const EXEMPT_ROUTES: Readonly<Record<string, string>> = {
  'pages/api/accounting/recurring-transactions-execute.ts':
    'executeRecurring asks the runner\'s Approve per template type in the service (journal: Accounts, invoice: Customers, bill: Suppliers) and leaves the document a draft without it',
};

/** MCP tools that require write:post or are named like a posting tool, yet post nothing. */
const EXEMPT_TOOLS: Readonly<Record<string, string>> = {
  apply_credit_note: 'posts no journal: the note\'s own journal posted at approval; only subledger balances move',
  unapply_credit_note: 'posts no journal: only subledger balances move',
  unapply_supplier_payment: 'posts no journal: only subledger balances move',
  adjust_credit_note_application: 'posts no journal: only subledger balances move',
  auto_apply_unapplied: 'posts no journal and creates no document: only subledger balances move',
  cancel_customer_invoice: 'drafts and pending-approval invoices only: no journal, nothing reverses',
  cancel_purchase_order: 'a purchase order has no journal',
  close_purchase_order: 'a purchase order has no journal',
  link_bills_to_purchase_order: 'links documents; posts nothing',
  cancel_bank_reconciliation: 'discards an in-progress reconciliation; posts nothing',
  finalize_uploads: 'attaches uploaded files; posts nothing',
  lock_budget_version: 'locks a budget version; no ledger effect',
  submit_budget_for_review: 'submits for review; approving it is approve_budget_version (gated)',
  submit_time_entries: 'submits for review; approving them is the Accountant\'s Area approve (gated on the routes)',
  lock_vat_period: 'locks a VAT period; posts nothing',
  mark_vat_declared_elsewhere: 'records where a period was declared; posts nothing',
};

/** A tool name that says it approves, posts, finalises or reverses. */
const POSTING_NAME = /^(approve|bulk_approve|finali[sz]e|bulk_finali[sz]e|post|run|close|year_end|book|reverse|void|cancel|settle|reopen|allocate|bulk_allocate|reallocate|split_allocate|perform|merge|confirm|process|apply|unapply|adjust|link|tag|set_opening|dispose|write_off|auto_apply|submit|mark|lock)_/;

const apiFiles = execFileSync('git', ['ls-files', 'pages/api'], { encoding: 'utf8' })
  .split('\n')
  .filter((f) => /\.ts$/.test(f) && !f.startsWith('pages/api/cron/') && !f.startsWith('pages/api/webhooks/'));

const CALL = new RegExp(`\\b(${POSTING_SERVICES.join('|')})\\s*\\(`);

/** The file's code, comments removed (a comment naming a service is not a call, nor one naming a gate a gate). */
function code(f: string): string {
  return readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

function callers(): string[] {
  return apiFiles.filter((f) => CALL.test(code(f)));
}

describe('approve / post entry-point census (#1656)', () => {
  it('the detector finds a call and a gate in the shapes routes use', () => {
    expect(CALL.test('const je = await postJournalEntry(companyId, id, userId);')).toBe(true);
    expect(CALL.test("import { postJournalEntry } from '...';")).toBe(false);
    expect(GATE.test("if (await refuseWithoutApprove(res, companyId, userId, 'accounts', 'x')) return;")).toBe(true);
    expect(GATE.test("import { refuseWithoutApprove } from '@/lib/approvePermissionResponse';")).toBe(false);
    expect(CALL.test(code('pages/api/accounting/eft-generate.ts'))).toBe(false); // names processBatch only in a comment
  });

  it('finds the posting routes (the census is not empty)', () => {
    expect(callers().length).toBeGreaterThan(50);
  });

  it('every route that calls a posting service asks the module Approve', () => {
    const ungated = callers().filter((f) => !EXEMPT_ROUTES[f] && !GATE.test(code(f)));
    expect(ungated, `Gate these with refuseWithoutApprove before any write, or exempt them with a reason: ${ungated.join(', ')}`)
      .toEqual([]);
  });

  it('every exempt route still calls a posting service (no stale pin)', () => {
    const stale = Object.keys(EXEMPT_ROUTES).filter((f) => !callers().includes(f));
    expect(stale).toEqual([]);
  });

  it('every MCP tool that posts declares its approve module', () => {
    const posting = MCP_TOOLS.filter((t) => t.requiresPost || POSTING_NAME.test(t.name));
    expect(posting.length).toBeGreaterThan(40);
    const missing = posting.filter((t) => !t.approveModule && !EXEMPT_TOOLS[t.name]).map((t) => t.name);
    expect(missing, `Declare approveModule on these tools, or exempt them with a reason: ${missing.join(', ')}`).toEqual([]);
  });

  it('every exempt tool exists and still lacks a module (no stale pin)', () => {
    const names = new Set(MCP_TOOLS.map((t) => t.name));
    const stale = Object.keys(EXEMPT_TOOLS).filter((n) => !names.has(n)
      || MCP_TOOLS.find((t) => t.name === n)!.approveModule !== undefined);
    expect(stale).toEqual([]);
  });

  it('the lead\'s named tools are gated', () => {
    const named = ['post_journal', 'post_reclassification_batch', 'allocate_bank_transaction', 'perform_bank_reconciliation',
      'close_fiscal_period', 'year_end_close', 'run_depreciation', 'run_recurring_journals', 'book_eti_for_month'];
    const byName = new Map(MCP_TOOLS.map((t) => [t.name, t]));
    expect(named.filter((n) => !byName.get(n)?.approveModule)).toEqual([]);
  });
});
