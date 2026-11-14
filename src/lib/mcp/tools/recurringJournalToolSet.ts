/**
 * The recurring-journal tools (MCP brief step 7), grouped so toolIndex.ts and flowMetering.ts each register them in
 * one line rather than growing past their size cap.
 */
import { createRecurringJournalTool, deactivateRecurringJournalTool } from './writeRecurringJournals';
import { runRecurringJournalsTool } from './writeRunRecurringJournals';

export const RECURRING_JOURNAL_TOOLS = [
  createRecurringJournalTool,
  runRecurringJournalsTool,
  deactivateRecurringJournalTool,
] as const;

/** All free: the app meters neither the template routes nor Generate (pages/api/accounting/recurring-journals*.ts). */
export const RECURRING_JOURNAL_FLOW_OPERATIONS = {
  create_recurring_journal: null,
  run_recurring_journals: null,
  deactivate_recurring_journal: null,
} as const;
