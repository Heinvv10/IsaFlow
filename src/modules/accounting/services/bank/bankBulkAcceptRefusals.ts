/**
 * What a refused bulk-accept line tells the caller (WP6): a typed refusal reads as its own sentence, one of three is
 * labelled by what to do about it, and anything else is a generic "internal error" (logged by the caller, never echoed).
 * The typed set is this module's own list - the refusals `allocateTransaction` raises before it writes for a line - not
 * the MCP boundary's REFUSAL_CODES, so the bank module does not depend on the MCP layer.
 */
import { BankControlError } from './bankControlRefusal';
import { isLockContention } from '../core/lockContention';

/** A line refused by the bulk accept's own checks (changed since the preview, no longer eligible, ...). */
export class LineRefused extends Error {}

export const GENERIC_REFUSAL = 'could not post (internal error)';

/** Codes whose message was written for the person and is raised before the line's first write. */
const TYPED_CODES: ReadonlySet<string> = new Set([
  'BANK_ALLOCATION_REFUSED', 'BANK_ACCOUNT_GUARD_REFUSED', 'BANK_TX_ALLOCATED', 'BANK_TX_NOT_POSTED',
  'RECONCILED_CASH', 'RECONCILIATION_COMPLETED', 'AGENT_FORBIDDEN', 'ALLOCATOR_MAY_NOT_REVERSE',
  'DIMENSION_REFUSED', 'DOCUMENT_LINE_ACCOUNT_REFUSED', 'HEADER_ACCOUNT_REFUSED', 'JOURNAL_DATE_REFUSED',
  'VAT_PERIOD_LOCKED', 'FISCAL_PERIOD_NOT_GENERATED', 'IMPERSONATION_FORBIDDEN',
]);
/** Posting guards with no code, by class name. */
const TYPED_NAMES: ReadonlySet<string> = new Set([
  'ClosedFiscalPeriodError', 'InactiveAccountError', 'MissingSystemAccountError', 'DuplicateTransferError',
]);

export function refusalReason(err: unknown): string {
  if (err instanceof LineRefused) return err.message;
  if (isLockContention(err)) return 'busy - retry (another request holds this line)';
  if (!(err instanceof Error)) return GENERIC_REFUSAL;
  const code = (err as { code?: unknown }).code;
  if (code === 'IMPORTER_MAY_NOT_ALLOCATE') return `needs a colleague: ${err.message}`;
  if (code === 'APPROVAL_REQUIRED' || err instanceof BankControlError) return `approval_required: ${err.message}`;
  if ((typeof code === 'string' && TYPED_CODES.has(code)) || TYPED_NAMES.has(err.name)) return err.message;
  return GENERIC_REFUSAL;
}
