/**
 * The MCP budget tools (budget write tools PR 1, 2026-11-16), grouped so toolIndex.ts, clientMetadata.ts and
 * flowMetering.ts each register them in one line. Reads need read:reports (budget figures are report data);
 * writes need write:budgets and the write role fence (owner / admin / manager); approve, lock, unlock and set
 * primary only on an owner's token. PR 3 (2026-11-17): drivers, three-way, remaining budget, overspend alerts and a
 * holder's slice submit; derive_three_way and budget_remaining check the write role in the handler (as their app
 * routes' withWriteAccess), budget_tracking is owner / admin (requiresRole), as the app's alerts route.
 */
import type { McpTool } from '../types';
import { BUDGET_READ_TOOLS as GRID_READ_TOOLS } from './budgetReadTools';
import { BUDGET_VERSION_TOOLS } from './budgetVersionTools';
import { seedBudgetTool } from './budgetSeedTool';
import { setBudgetAmountsTool, setBudgetAnnualTool } from './budgetAmountTools';
import { restoreBudgetVersionTool } from './budgetRestoreTool';
import { BUDGET_GATE_TOOLS } from './budgetGateTools';
import { getBudgetDriversTool } from './budgetDriverRead';
import { setBudgetDriversTool } from './budgetDriverWrite';
import { deriveThreeWayTool, getThreeWayTool, setThreeWayAssumptionsTool } from './budgetThreeWayTools';
import { budgetRemainingTool, budgetTrackingTool } from './budgetControlTools';
import { submitBudgetForReviewTool } from './budgetSliceTools';

/** PR 3 added the drivers, the three-way forecast, remaining budget and the overspend alerts. */
export const BUDGET_READ_TOOLS: McpTool[] = [
  ...GRID_READ_TOOLS, getBudgetDriversTool, getThreeWayTool, deriveThreeWayTool, budgetRemainingTool, budgetTrackingTool,
];

export const BUDGET_WRITE_TOOLS: McpTool[] = [
  ...BUDGET_VERSION_TOOLS,
  seedBudgetTool,
  setBudgetAmountsTool,
  setBudgetAnnualTool,
  restoreBudgetVersionTool,
  ...BUDGET_GATE_TOOLS,
  // PR 3: drivers, three-way assumptions, a holder's slice submit.
  setBudgetDriversTool,
  setThreeWayAssumptionsTool,
  submitBudgetForReviewTool,
];

/** All free: the app's budget routes are not Flow-metered (budget-grid/**, budget-versions/**). */
export const BUDGET_FLOW_OPERATIONS: Record<string, null> = Object.fromEntries(
  [...BUDGET_READ_TOOLS, ...BUDGET_WRITE_TOOLS].map((t) => [t.name, null]),
);
