/**
 * Journal Entry Service — Facade
 * Re-exports from journalEntryCrudService and journalEntryPostingService
 * for backward compatibility.
 */

export type { JournalEntryFilters } from './journalEntryCrudService';
export {
  getJournalEntries,
  getJournalEntryById,
  createJournalEntry,
  getTrialBalance,
  mapEntryRow,
  mapLineRow,
  resolveUserUuid,
} from './journalEntryCrudService';

export {
  postJournalEntry,
  reverseJournalEntry,
} from './journalEntryPostingService';
