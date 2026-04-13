/**
 * Data Archiving & Retention Engine Service — Facade
 * Re-exports from archiveQueryService, archiveReadService, and archiveExecutionService
 * for backward compatibility.
 */

export type {
  StorageStats,
  ArchivePreview,
  ArchiveValidation,
  ArchiveRun,
} from './archiveQueryService';

export {
  getStorageStats,
  previewArchive,
  validateArchive,
  getArchiveRuns,
} from './archiveQueryService';

export type { ArchivedEntry } from './archiveReadService';
export { getArchivedEntries } from './archiveReadService';

export type { ArchiveResult } from './archiveExecutionService';
export { executeArchive } from './archiveExecutionService';
