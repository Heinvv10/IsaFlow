/**
 * Assembles MCP_TOOLS into the singleton registry the transport dispatches
 * through. Read tools register here (Task 2.6); write/post tools append in
 * Phase 3. The drift-guard test keeps CLIENT_MCP_TOOL_NAMES in sync.
 */
import { McpRegistry } from './registry';
import { companyProfileTool, listCompaniesTool } from './tools/company';
import {
  agedCreditorsTool,
  agedDebtorsTool,
  balanceSheetTool,
  listGlAccountsTool,
  profitAndLossTool,
  searchGlTool,
  trialBalanceTool,
} from './tools/reports';
import { getInvoiceTool, listInvoicesTool, listQuotesTool } from './tools/invoices';
import { listCustomersTool, listSuppliersTool } from './tools/contacts';
import { bankAccountsStatusTool, listBankTransactionsTool } from './tools/bank';
import { listImportBatchesTool } from './tools/importBatches';
import { listJournalsTool } from './tools/journals';
import { attachDocumentTool } from './tools/writeAttachDocument';
import { getMatchCandidatesTool } from './tools/bankMatch';
import { vatStatusTool } from './tools/vat';
import { chartOfAccountsHealthTool, dataIntegrityChecksTool } from './tools/integrity';
import { lockVatPeriodTool, vat201ExportTool, vatReconciliationTool } from './tools/vatReports';
import { listAgentPostingsTool } from './tools/agentActivity';
import {
  createDraftInvoiceTool,
  createDraftQuoteTool,
  finalizeInvoiceTool,
} from './tools/writeInvoices';
import { createDraftJournalTool, postJournalTool } from './tools/writeJournals';
import { suggestBankAllocationTool } from './tools/writeBank';
import { allocateBankTransactionTool, reverseBankAllocationTool } from './tools/writeBankAllocate';
import { importBankStatementTool, undoBankImportTool } from './tools/writeBankImport';
import {
  bulkAllocateBankTransactionsTool,
} from './tools/writeBankBulkAllocate';
import { reverseBankAllocationBatchTool } from './tools/writeBankReverseBatch';
import { reverseAllocationsTool } from './tools/writeBankReverseRange';
import { setOpeningBalanceTool } from './tools/writeOpeningBalance';
import {
  createGlAccountTool,
  updateGlAccountTool,
  deactivateGlAccountTool,
} from './tools/writeGlAccounts';
import { listSupplierInvoicesTool, getSupplierInvoiceTool } from './tools/supplierInvoices';
import {
  createSupplierInvoiceTool,
  approveSupplierInvoiceTool,
} from './tools/writeSupplierInvoices';
import { listBankRulesTool, getBankRuleTool } from './tools/bankRules';
import { listCreditNotesTool, getCreditNoteTool } from './tools/creditNotes';
import {
  createCreditNoteTool,
  approveCreditNoteTool,
  cancelCreditNoteTool,
} from './tools/writeCreditNotes';
import {
  listBankReconciliationsTool,
  cancelBankReconciliationTool,
} from './tools/bankReconciliations';
import {
  createBankRuleTool,
  updateBankRuleTool,
  disableBankRuleTool,
} from './tools/writeBankRules';
import {
  listPracticeClientsTool,
  listJobCategoriesTool,
  listWorkItemsTool,
  listTimeEntriesTool,
} from './tools/practice';
import { createJobCategoryTool, createWorkItemTool } from './tools/writePracticeSetup';
import { logTimeEntryTool, submitTimeEntriesTool } from './tools/writePracticeTime';

export const MCP_TOOLS = [
  // read (36)
  companyProfileTool,
  listCompaniesTool,
  trialBalanceTool,
  profitAndLossTool,
  balanceSheetTool,
  agedDebtorsTool,
  agedCreditorsTool,
  searchGlTool,
  listGlAccountsTool,
  listInvoicesTool,
  getInvoiceTool,
  listQuotesTool,
  listCustomersTool,
  listSuppliersTool,
  bankAccountsStatusTool,
  listBankTransactionsTool,
  getMatchCandidatesTool,
  vatStatusTool,
  vatReconciliationTool,
  vat201ExportTool,
  dataIntegrityChecksTool,
  chartOfAccountsHealthTool,
  listAgentPostingsTool,
  listSupplierInvoicesTool,
  getSupplierInvoiceTool,
  listBankRulesTool,
  getBankRuleTool,
  listImportBatchesTool,
  listJournalsTool,
  listBankReconciliationsTool,
  listPracticeClientsTool,
  listJobCategoriesTool,
  listWorkItemsTool,
  listTimeEntriesTool,
  listCreditNotesTool,
  getCreditNoteTool,
  // write (32) — drafts + suggest + import/undo are write; post/finalize/allocate/reverse
  // (single and batch) additionally require write:post. Import posts nothing, so
  // it stays off write:post.
  createDraftInvoiceTool,
  createDraftQuoteTool,
  createDraftJournalTool,
  suggestBankAllocationTool,
  postJournalTool,
  finalizeInvoiceTool,
  allocateBankTransactionTool,
  reverseBankAllocationTool,
  bulkAllocateBankTransactionsTool,
  reverseBankAllocationBatchTool,
  importBankStatementTool,
  undoBankImportTool,
  createGlAccountTool,
  updateGlAccountTool,
  deactivateGlAccountTool,
  createSupplierInvoiceTool,
  approveSupplierInvoiceTool,
  createBankRuleTool,
  updateBankRuleTool,
  disableBankRuleTool,
  reverseAllocationsTool,
  setOpeningBalanceTool,
  attachDocumentTool,
  cancelBankReconciliationTool,
  // Practice: setup posts nothing; log/submit book billable hours that feed WIP
  // and invoicing but write no journal, so neither is requiresPost.
  createJobCategoryTool,
  createWorkItemTool,
  logTimeEntryTool,
  submitTimeEntriesTool,
  createCreditNoteTool,
  approveCreditNoteTool,
  cancelCreditNoteTool,
  // Records that a VAT period has been filed. requiresPost because it freezes
  // a filed return: a control an agent can set without write:post is not one.
  lockVatPeriodTool,
] as const;

export const mcpRegistry = new McpRegistry();
for (const tool of MCP_TOOLS) {
  mcpRegistry.register(tool);
}
