/**
 * The typed refusals a bank route may answer with a 4xx — and ONLY those (audit WP2 row 9).
 *
 * `withAuth` decides COMMIT vs ROLLBACK on `statusCode >= 500`, so the status a route gives a throw is the request's
 * fate. Several bank routes ended their catch with `badRequest(res, err.message)` (or `badRequestFromError`): a crash
 * after the request had written — a deleted line, a started or cancelled reconciliation, seeded rules, saved auto-post
 * settings — was answered 400 and COMMITTED, half done. The routes now answer what this recognises and rethrow the
 * rest, so `withErrorHandler` gives the 500 and the request rolls back. The default is NOT classified.
 *
 * Every member is a refusal decided before its caller's first write, or inside a savepoint its throw rolls back
 * (allocate, split, reverse and the reconciliation adjustment post through `withJournalDateRefusal`'s savepoint — the
 * posting-guard refusals below reach a route only that way). Add a class only with that shown.
 *
 * STRUCTURAL checks (a `code` or a `name`), not `instanceof`, as `bankMatchRefusalStatus` does: importing every
 * refusal's module here would drag the services into each route test's mocks.
 *
 * Route-specific refusals (lock timeouts, a completed reconciliation, an approval rule, a bank control, retryable
 * contention, a feed row not posted) keep their own responders, which each route consults first.
 */
import type { NextApiResponse } from 'next';
import { apiResponse } from '@/lib/apiResponse';
import { ErrorCode } from '@/lib/apiResponse.types';
import { isHeldRowError } from '@/lib/lockTimeout';
import { REFUSAL_CODES } from '@/lib/mcp/tools/refusalCodes';
import { isBankRequestRefusal } from './bankRequestRefusal';
import { isBankAllocationRefusal } from './bankAllocationRefusal';

export type BankRefusalStatus = 400 | 404 | 409;

/**
 * Typed refusals that carry no registered code, by class name, each raised before its caller writes: a cancel or a
 * reopen refused, out-of-range auto-post settings, and the posting guards (a duplicate transfer, a closed period, a
 * deactivated account, a missing system account), which reach a bank route only from inside
 * `withJournalDateRefusal`'s savepoint.
 */
const NAMED_REFUSALS: ReadonlySet<string> = new Set([
  'ReconciliationNotCancellableError', 'ReconciliationNotReopenableError', 'AutoPostSettingsInvalidError',
  'DuplicateTransferError', 'ClosedFiscalPeriodError', 'InactiveAccountError',
  // The company has no account in a system role the posting needs (e.g. Input VAT - late claims): resolved before
  // createJournalEntry inserts (vat-period-lock-routes.int.test.ts pins it 400, no draft journal).
  'MissingSystemAccountError',
]);

/** The 4xx for a typed bank refusal, or null: not classified, the route rethrows it (500, rolled back). */
export function bankRefusalStatus(err: unknown): BankRefusalStatus | null {
  // A held row is 503 + Retry-After and rolls back (respondIfLockTimeout / withErrorHandler), never a 4xx here.
  if (!(err instanceof Error) || isHeldRowError(err)) return null;
  if (isBankRequestRefusal(err)) return err.status;
  // A peer changed the line while this request decided: retry (409); every other allocation refusal is 400.
  if (isBankAllocationRefusal(err)) return err.retryable ? 409 : 400;
  const code = (err as { code?: unknown }).code;
  // A match target refused (missing, claimed, reversed, not this line's bank leg): 400, as these routes have always
  // answered it; a reconciliation that is not there is 404 (auto_match's own branch answers it before this).
  if (err.name === 'BankMatchTargetError') return code === 'RECONCILIATION_NOT_FOUND' ? 404 : 400;
  if (NAMED_REFUSALS.has(err.name)) return 400;
  // Every other typed refusal: the allowlist the MCP boundary trusts, kept complete by its census
  // (typedRefusalReachesAgent.test.ts) — each class there is raised before its caller writes. So a supplier-payment,
  // receipt, VAT, contact or reconciliation refusal stays a 400 without being listed twice. A bare Error, a SQLSTATE,
  // a TypeError carry none of these codes: not classified, 500.
  return typeof code === 'string' && REFUSAL_CODES.has(code) ? 400 : null;
}

/** Answers a typed bank refusal with its 4xx and the refusal's own message; false when `err` is not one. */
export function respondIfBankRefusal(res: NextApiResponse, err: unknown): boolean {
  const status = bankRefusalStatus(err);
  if (status === null) return false;
  const message = (err as Error).message;
  if (status === 409) apiResponse.conflict(res, message);
  else if (status === 404) apiResponse.error(res, ErrorCode.NOT_FOUND, message);
  else apiResponse.badRequest(res, message);
  return true;
}
