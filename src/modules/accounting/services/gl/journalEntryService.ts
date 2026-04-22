/**
 * Journal Entry Service — Facade
 * Re-exports from journalEntryCrudService and journalEntryPostingService
 * for backward compatibility.
 */

export type { JournalEntryMeta } from './journalEntryMeta';
export { defaultHumanMeta } from './journalEntryMeta';

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
