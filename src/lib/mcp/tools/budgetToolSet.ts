/**
 * The MCP budget tools (budget write tools PR 1, 2026-11-16), grouped so toolIndex.ts, clientMetadata.ts and
 * flowMetering.ts each register them in one line. Reads need read:reports (budget figures are report data);
 * writes need write:budgets and the write role fence (owner / admin / manager); approve, lock, unlock and set
 * primary only on an owner's token.
 */
import type { McpTool } from '../types';
import { BUDGET_READ_TOOLS } from './budgetReadTools';
import { BUDGET_VERSION_TOOLS } from './budgetVersionTools';
import { seedBudgetTool } from './budgetSeedTool';
import { setBudgetAmountsTool, setBudgetAnnualTool } from './budgetAmountTools';
import { restoreBudgetVersionTool } from './budgetRestoreTool';
import { BUDGET_GATE_TOOLS } from './budgetGateTools';

export { BUDGET_READ_TOOLS };

export const BUDGET_WRITE_TOOLS: McpTool[] = [
  ...BUDGET_VERSION_TOOLS,
  seedBudgetTool,
  setBudgetAmountsTool,
  setBudgetAnnualTool,
  restoreBudgetVersionTool,
  ...BUDGET_GATE_TOOLS,
];

/** All free: the app's budget routes are not Flow-metered (budget-grid/**, budget-versions/**). */
export const BUDGET_FLOW_OPERATIONS: Record<string, null> = Object.fromEntries(
  [...BUDGET_READ_TOOLS, ...BUDGET_WRITE_TOOLS].map((t) => [t.name, null]),
);
