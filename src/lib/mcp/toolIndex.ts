/**
 * Assembles MCP_TOOLS into the singleton registry the transport dispatches
 * through. Read tools register here (Task 2.6); write/post tools append in
 * Phase 3. The drift-guard test keeps CLIENT_MCP_TOOL_NAMES in sync.
 */
import { McpRegistry } from './registry';
import { companyProfileTool } from './tools/company';
import {
  agedCreditorsTool,
  agedDebtorsTool,
  balanceSheetTool,
  profitAndLossTool,
  searchGlTool,
  trialBalanceTool,
} from './tools/reports';
import { getInvoiceTool, listInvoicesTool, listQuotesTool } from './tools/invoices';
import { listCustomersTool, listSuppliersTool } from './tools/contacts';
import { bankAccountsStatusTool, listBankTransactionsTool } from './tools/bank';
import { vatStatusTool } from './tools/vat';

export const MCP_TOOLS = [
  companyProfileTool,
  trialBalanceTool,
  profitAndLossTool,
  balanceSheetTool,
  agedDebtorsTool,
  agedCreditorsTool,
  searchGlTool,
  listInvoicesTool,
  getInvoiceTool,
  listQuotesTool,
  listCustomersTool,
  listSuppliersTool,
  bankAccountsStatusTool,
  listBankTransactionsTool,
  vatStatusTool,
] as const;

export const mcpRegistry = new McpRegistry();
for (const tool of MCP_TOOLS) {
  mcpRegistry.register(tool);
}
