/**
 * The year-end close's public entry point and its result contracts.
 *
 * The close itself is a CONTROLLED operation: `controlledYearEnd` runs it
 * through the approval kernel, so every close carries a permit, a receipt and
 * an append-only change record, and a repeat call replays the receipt instead
 * of writing twice. The orchestration that used to live in this file went with
 * it; what is left here is the module's name, which every caller already
 * imports.
 *
 * The SHAPES are not the controlled writer's own. They live in
 * `yearEndCloseTypes` and are re-exported here unchanged, so
 * `yearEndJournalBuilder`, `yearEndJournalPoster` and the controlled writer all
 * answer with one contract rather than two that drift. Declaring a narrower
 * private copy here is exactly how the controlled path came to be missing
 * `alreadyClosed` and the ledger-based detection behind it.
 */

export type {
  CloseYearDryRunResult,
  CloseYearError,
  CloseYearOptions,
  CloseYearResult,
  YearEndJournalLine,
  YearEndJournalPreview,
} from './yearEndCloseTypes';

export { closeFiscalYear } from './controlledYearEnd';
