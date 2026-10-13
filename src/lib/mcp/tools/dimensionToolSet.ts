/**
 * The CC1 / CC2 / BU dimension tools, grouped so toolIndex.ts registers them in
 * one place each (reads with the reads, writes with the writes).
 */
import { createBusinessUnitTool, createCostCentreTool, listBusinessUnitsTool, listCostCentresTool } from './dimensionMasterTools';
import { exportGlLinesTool } from './exportGlLines';
import {
  deleteBusinessUnitTool, deleteCostCentreTool, updateBusinessUnitTool, updateCostCentreTool,
} from './dimensionMasterEditTools';
import {
  setBankAccountDefaultDimensionsTool, setCustomerDefaultFnoTool, setGlAccountReportingAttributesTool,
  setSupplierDefaultDimensionsTool,
} from './dimensionDefaultsTools';
import { reverseDimensionTagBatchTool, tagJournalLinesTool } from './writeDimensionTags';
import { syncBankDimensionsTool } from './writeBankDimensionSync';
import { splitAllocateBankTransactionTool } from './writeBankSplit';

export const DIMENSION_READ_TOOLS = [listCostCentresTool, listBusinessUnitsTool, exportGlLinesTool] as const;

export const DIMENSION_WRITE_TOOLS = [
  createCostCentreTool,
  createBusinessUnitTool,
  updateCostCentreTool,
  deleteCostCentreTool,
  updateBusinessUnitTool,
  deleteBusinessUnitTool,
  setGlAccountReportingAttributesTool,
  setCustomerDefaultFnoTool,
  setBankAccountDefaultDimensionsTool,
  setSupplierDefaultDimensionsTool,
  // Post (requiresPost): a split posts a journal; tagging rewrites posted lines' dimensions in place.
  splitAllocateBankTransactionTool,
  tagJournalLinesTool,
  reverseDimensionTagBatchTool,
  // Copies journal tags onto allocated bank rows (bank metadata only, no posting).
  syncBankDimensionsTool,
] as const;
