/**
 * The approve / post census's primitives and gates (the analyser's inputs; approvePostEntryCensus.test.ts and a human following a
 * finding both read it).
 *
 * SINKS map a posting / reversing / approving service to the module whose Approve a route must hold before calling it ('*': the
 * module is decided by the document, any module's gate will do). They are a floor, not the definition: SQL_PRIMITIVES also
 * marks as a sink every function that itself posts a journal or flips a document to approved in SQL, so a new posting function
 * is caught without being named here (round 4, F-M2).
 */
import type { GateSpec } from './approveCensusGraph';
import type { ModuleResolver, SqlPrimitive } from './approveCensusProgram';
import { returnApproveModule } from '@/modules/accounting/services/returns/returnForm';

export const SINK_MODULES: Readonly<Record<string, string>> = {
  // GL / accounts
  postJournalEntry: 'accounts', reverseJournalEntry: 'accounts', postOpeningBalances: 'accounts', executeMigration: 'accounts',
  runDepreciation: 'accounts', closeFiscalYear: 'accounts', closePeriod: 'accounts', closeYear: 'accounts', lockPeriod: 'accounts',
  reopenPeriod: 'accounts', runBulkPeriodAction: 'accounts', runRecurringJournal: 'accounts', postAssetDisposalToGL: 'accounts',
  postCapitalizationExpenseToGL: 'accounts', closeLoanPeriod: 'accounts', postPeriodJournals: 'accounts',
  softDelete: '*', undoDelete: '*', // an invoice delete / undo: the invoice's module (customers or suppliers) is chosen by the entity type
  postEliminationAdjustment: 'group', reverseEliminationAdjustment: 'group',
  // AP
  approveSupplierInvoice: 'suppliers', cancelSupplierInvoice: 'suppliers', postSupplierInvoiceToGL: 'suppliers',
  approveSupplierPayment: 'suppliers', processSupplierPayment: 'suppliers', voidSupplierPayment: 'suppliers', approveBatch: 'suppliers',
  processBatch: 'suppliers', reverseBatch: 'suppliers', approveCreditNote: '*', cancelCreditNote: '*', approveClaim: 'suppliers',
  postClaimToGl: 'suppliers', postReceiptAsPettyCashJournal: 'suppliers', runCapturePostFollowUps: 'suppliers',
  attachEvidenceAndSettleApproved: 'suppliers',
  // AR
  approveCustomerInvoice: 'customers', cancelCustomerInvoice: 'customers', postCustomerInvoiceToGL: 'customers',
  confirmCustomerPayment: 'customers', cancelCustomerPayment: 'customers', runRecurringInvoice: 'customers', approveWriteOff: 'customers',
  // banking
  allocateTransaction: 'banking', splitAllocateTransaction: 'banking', bulkAcceptTransactions: 'banking',
  reverseReconciledTransaction: 'banking', confirmBulkAccept: 'banking', undoBulkAcceptBatch: 'banking', confirmReceiptMatch: 'banking',
  confirmCustomerInvoiceMatch: 'banking', confirmSupplierInvoiceMatch: 'banking', confirmPurchaseOrderMatch: 'banking',
  postBankTransfer: 'banking', postProvisional: 'banking', reopenReconciliation: 'banking',
  // VAT, items, practice, budgets, approvals
  // finaliseReturn: VAT201 (vat) or EMP501 (payroll), the return's own module
  approveVATAdjustment: 'vat', finaliseReturn: 'returns',
  approveAdjustment: 'items', approveEntries: 'accountant',
  approvePracticeEntries: 'accountant', transitionVersion: 'budgets', decideRequest: '*', approvePurchaseOrder: 'suppliers',
  // payroll
  approvePayrollRun: 'payroll', reopenPayrollRun: 'payroll', postBatch: 'payroll', bookEtiForMonthLocked: 'payroll',
  markUifDeclarationPaid: 'payroll',
  // money leaving: the EFT batch sent to Netcash
  submitEftBatch: 'suppliers',
  // recurring templates (the run decides per template type)
  executeRecurring: '*',
};

export const POSTING_SERVICES = Object.keys(SINK_MODULES);

/**
 * A gate whose module argument is returnApproveModule(<form>) asks the form's module, read from the REAL mapping (r13 L2): a literal
 * form is 'returns:<its module>' (EMP501 -> 'returns:payroll'), a form the census cannot read is 'returns' (some return's module),
 * an unmapped literal form covers nothing.
 */
export const RETURN_MODULE_RESOLVERS: Readonly<Record<string, ModuleResolver>> = {
  returnApproveModule: (form) => (form === null ? 'returns' : ((m) => (m ? `returns:${m}` : '?'))(returnApproveModule(form))),
};

/**
 * SQL that makes the function holding it a primitive (matched against the static text of its tagged templates and `.query()` calls, a
 * bind with a static value read in place), and the module whose Approve the route reaching it must hold (#1670 breaker L1c/d): a
 * Budgets gate does not cover a bill flipped to approved. '*' where the document decides the module (a journal, posted by every module;
 * a credit note; a tax return). The documents and modules follow APPROVE_MODULE_BY_DOCUMENT and SINK_MODULES above.
 */
const flips = (tables: string, statuses: string, module: string, caseForm = true) => {
  const T = `(?:public\\.)?(?:${tables})\\b`;
  const noWhere = (n: number) => `(?:(?!\\bWHERE\\b)[^;]){0,${n}}?`;
  // `status = '<s>'`, or `status = CASE ... THEN '<s>'` (r13 L3)
  const set = `\\bstatus\\s*=\\s*${caseForm ? '(?:CASE(?:(?!\\bEND\\b)[^;]){0,400}?\\bTHEN\\s*)?' : ''}'(?:${statuses})'`;
  return {
    module,
    // `SET ... status = '<s>'` before any WHERE (a cancel `WHERE status = 'approved'` is no approval); `SET (status, ...) = ('<s>', ...)`;
    // an upsert's `ON CONFLICT ... DO UPDATE SET status = '<s>'` (r13 L3)
    re: new RegExp([
      `UPDATE\\s+${T}${noWhere(300)}\\bSET\\b${noWhere(600)}${set}`,
      `UPDATE\\s+${T}${noWhere(300)}\\bSET\\s*\\([^)]*\\bstatus\\b[^)]*\\)\\s*=\\s*\\([^)]*'(?:${statuses})'`,
      `INSERT\\s+INTO\\s+${T}[^;]{0,1500}?\\bON\\s+CONFLICT\\b[^;]{0,400}?\\bDO\\s+UPDATE\\s+SET\\b${noWhere(600)}${set}`,
    ].join('|'), 'i'),
  };
};
export const SQL_PRIMITIVES: readonly SqlPrimitive[] = [
  { module: '*', re: /UPDATE\s+(?:public\.)?gl_journal_entries[^;]{0,400}?status\s*=\s*'posted'/i },
  { module: '*', re: /INSERT\s+INTO\s+(?:public\.)?gl_journal_entries[^;]{0,600}?'posted'/i },
  { module: 'customers', re: /UPDATE\s+(?:public\.)?customer_invoices[^;]{0,300}?SET[^;]{0,300}?status\s*=\s*'approved'/i },
  { module: 'suppliers', re: /UPDATE\s+(?:public\.)?supplier_invoices[^;]{0,300}?SET[^;]{0,300}?status\s*=\s*'approved'/i },
  // Invoices without the CASE form: their payment recompute sets `status = CASE ... WHEN status IN ('partially_paid', 'paid') THEN
  // 'approved'`, an un-payment back to the approved state, no approval (invoiceStatusRecompute, the allocation reversals).
  flips('gl_journal_entries', 'posted', '*'), flips('customer_invoices', 'approved', 'customers', false), flips('supplier_invoices', 'approved', 'suppliers', false),
  flips('credit_notes', 'approved', '*'),
  flips('supplier_payments', 'approved|processed', 'suppliers'),
  flips('supplier_payment_batches', 'approved|processed|reversed', 'suppliers'),
  flips('purchase_orders', 'approved', 'suppliers'),
  flips('expense_claims', 'approved|posted', 'suppliers'),
  flips('customer_payments', 'confirmed', 'customers'),
  flips('customer_write_offs', 'approved', 'customers'),
  flips('payroll_run_headers', 'approved', 'payroll'),
  flips('payroll_batches', 'posted', 'payroll'),
  flips('uif_declarations', 'paid', 'payroll'),
  flips('vat_adjustments', 'approved', 'vat'),
  flips('accounting_adjustments', 'approved', 'items'),
  flips('consolidation_adjustments', 'posted|reversed', 'group'),
  flips('budget_versions', 'approved', 'budgets'),
  flips('fiscal_periods', 'closed|locked', 'accounts'),
  // A return finalised or filed (Hein's gate-everything ruling, 2026-11-21) takes the FORM's module Approve: 'returns', which only a gate
  // whose module is returnApproveModule(...) gives (RETURN_MODULE_RESOLVERS; r12 L1: a literal 'vat' or 'budgets' gate is a finding).
  flips('tax_return_versions', 'finalised|filed|superseded', 'returns'), // superseded: an amend (r13 M1)
  { module: 'returns', re: /INSERT\s+INTO\s+(?:public\.)?tax_return_versions\b/i }, // the finalise: a new version, status 'finalised' (r13 M1)
  flips('sars_submissions', 'submitted', 'returns'), // the legacy / ISV way of marking a return submitted
  { module: 'vat', re: /INSERT\s+INTO\s+(?:public\.)?vat_period_locks\b/i }, // a VAT period lock records the filed VAT201 (r13 L2: VAT's)
  flips('uif_declarations', 'submitted', 'payroll'), // the UIF declaration marked submitted (re-arms markPaid)
];

/**
 * How each gate answers. `refuse`: true means REFUSED (the route returns on it); `allow`: true means allowed; `assert`: throws when
 * refused. `moduleArg`: the index of the module argument, or `module` when the gate is for one module; a non-literal module
 * argument counts as '*'.
 */
export const GATES: Readonly<Record<string, GateSpec>> = {
  refuseWithoutApprove: { kind: 'refuse', moduleArg: 3 },
  refuseWithoutGroupApprove: { kind: 'refuse', moduleArg: 3 },
  refuseApprovalRequestWithoutApprove: { kind: 'refuse', module: '*' },
  mayApprove: { kind: 'allow', moduleArg: 2 },
  mayApproveInGroup: { kind: 'allow', moduleArg: 2 },
  mayApproveSupplierInvoices: { kind: 'allow', module: 'suppliers' },
  assertMayApprove: { kind: 'assert', moduleArg: 2 },
  assertMayApproveCreditNote: { kind: 'assert', module: '*' },
  // an invoice delete / undo asks the invoice's own module (customers or suppliers) from its entity type
  mayApproveInvoiceDelete: { kind: 'allow', module: '*' },
};

/**
 * Wrappers on the default export that gate the whole route for one module's APPROVE. None: withPayrollModule asks Payroll read or
 * write, never Approve, so it proves nothing about posting (#1670 Codex); it stays in PAYROLL_READ_WRAPPERS for the access census.
 */
export const ROUTE_WRAPPERS: Readonly<Record<string, string>> = {};

/**
 * The payroll-READ census (round 6): a route outside pages/api/payroll that returns one person's pay must ask Payroll read. SQL on these
 * per-employee tables makes the function holding it a primitive; the gates are Payroll read (refuseWithoutPayrollRead, mayReadPayroll)
 * and the wrappers that ask it. Aggregate totals (a count, a monthly PAYE sum) are exempted per site with `census-exempt(sql, payroll-read)`
 * or `census-exempt(<callee>, payroll-read)` and a reason.
 */
export const PAYROLL_DETAIL_SQL: readonly RegExp[] = [
  /\b(?:FROM|JOIN)\s+(?:"?public"?\.)?"?(?:payslips|payroll_payslips|payroll_run_lines|payroll_employees|payroll_employee_components|payroll_irp5\w*|employees)"?\b/i,
  // Round 7 (M3c): the rest of the per-employee tables, a person's bank details, loans, garnishees, directives and payments
  /\b(?:FROM|JOIN)\s+(?:"?public"?\.)?"?(?:payroll_bank_details|payroll_bank_file_items|tax_directive_payments|tax_directives|payroll_loans?\w*|payroll_garnishee_\w+|payroll_external_payslips|payroll_batch_lines|payroll_employee_history|payroll_employee_fringe_benefits|pay_packages|payslip_deliveries|practice_staff_cost_rates)"?\b/i,
  // the change history of an employee or of an employee's bank details
  /\bFROM\s+(?:public\.)?entity_changes\b[^;]*?'?payroll_(?:employee|bank_detail)\b/is,
];
export const PAYROLL_READ_GATES: Readonly<Record<string, GateSpec>> = {
  refuseWithoutPayrollRead: { kind: 'refuse', module: 'payroll' },
  mayReadPayroll: { kind: 'allow', module: 'payroll' },
  // a write path that touches a payroll table (cost rates): Payroll write is asked, which is the stricter question
  refuseWithoutPayrollWrite: { kind: 'refuse', module: 'payroll' },
};
export const PAYROLL_READ_WRAPPERS: Readonly<Record<string, string>> = { withPayrollModule: 'payroll', withPayrollDetailAccess: 'payroll' };

/**
 * The posting census's rules, for the real tree (approvePostEntryCensus) and the fixtures (approveCensusFixtures). flagPrimitiveRoots +
 * queryCalls (#1670 Codex): a handler that posts in its OWN SQL (sql`` or client.query) calls no sink, and was not judged.
 */
export const POSTING_RULES = {
  sinks: SINK_MODULES, gates: GATES, routeWrappers: ROUTE_WRAPPERS, sqlPrimitives: SQL_PRIMITIVES, flagPrimitiveRoots: true, queryCalls: true,
  markerScope: 'posting', moduleResolvers: RETURN_MODULE_RESOLVERS, strictModules: ['returns'],
} as const;
