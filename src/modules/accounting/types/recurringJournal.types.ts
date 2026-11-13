/**
 * Recurring journal templates (`recurring_journals`, migrations 206 / 220 / 869 / 989). Re-exported from gl.types.ts,
 * which every existing caller imports them from.
 */
import type { JournalLineInput } from './gl.types';
import type { JournalEntryMeta } from '../services/gl/journalEntryMeta';

export type RecurringFrequency = 'weekly' | 'monthly' | 'quarterly' | 'annually';
export type RecurringStatus = 'active' | 'paused' | 'completed' | 'cancelled';

export interface RecurringJournal {
  id: string;
  templateName: string;
  description?: string;
  frequency: RecurringFrequency;
  nextRunDate: string;
  endDate?: string;
  lastRunDate?: string;
  runCount: number;
  status: RecurringStatus;
  lines: JournalLineInput[];
  totalAmount: number;
  /** A run posts its journal (true) or leaves it a draft (migration 989). */
  autoPost: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface RecurringJournalCreateInput {
  templateName: string;
  description?: string;
  frequency: RecurringFrequency;
  nextRunDate: string;
  endDate?: string;
  lines: JournalLineInput[];
  /** Omitted: true, as the app's create route has always behaved. */
  autoPost?: boolean;
}

/** One run: the journal it minted, and — R-035 PR6 — the journals approval holds as drafts (it or nothing). */
export interface RecurringJournalRun {
  journalId: string;
  entryNumber: string;
  heldForApproval: string[];
  /** A template line's cost-centre pick the run dropped (dimensions/costCentrePick); absent when none. */
  warnings?: string[];
  /** False when the journal was left a draft: the template does not auto-post (migration 989), or approval holds it. */
  posted: boolean;
}

/**
 * Who is running it. `meta` stamps the journal (an MCP run is an agent's, not the token owner's own work).
 * `agent`: an agent may neither raise nor decide an approval (R-035 Q6), so a journal approval would hold is refused
 * before the claim when the template posts, and a draft-only template's journal is marked but raises no request.
 */
export interface RecurringRunOptions {
  meta?: JournalEntryMeta;
  agent?: boolean;
  /** A dry run (rolled back by the caller): no "Generated" log line for a journal that will not exist. */
  preview?: boolean;
}
