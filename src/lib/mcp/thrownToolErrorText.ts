/**
 * What a tool call that THREW answers (moved out of registry.ts, 2026-10-15, to keep it under 300 lines). By the
 * time this runs the registry has rolled the tool's savepoint back, refunded the call and audited it 'error' with a
 * NULL key; this only chooses the caller-facing text. Never SQL, never a stack.
 */
import { BulkAllocationLineError, bulkAllocationLineErrorText } from './bulkAllocationLineError';
import { BankLineDirectionError, bankLineDirectionErrorText } from './bankLineDirectionError';
import { MissingSystemAccountError, missingSystemAccountText } from '@/modules/accounting/services/gl/systemAccountKeys';
import { isRefusalCoded } from './tools/toolHelpers';
import { lockWaitErrorText } from './lockWaitError';

export const GENERIC_FAILURE = 'The operation failed. Please try again or contact support.';

export function thrownToolErrorText(name: string, err: unknown): string {
  // A BATCH tool that failed on one identifiable line is the one case where
  // GENERIC_FAILURE is the wrong answer. "The operation failed" tells an
  // agent holding 124 lines nothing it can act on — the pilot bisected such
  // a batch by hand. The line index and its transaction id are the agent's
  // OWN input, so naming them leaks nothing, and the message the tool built
  // is already free of SQL and stack. Everything else about this path is
  // unchanged: rolled back by the savepoint, refunded, audited 'error' with
  // a NULL key so the retry is not burned.
  if (err instanceof BulkAllocationLineError) {
    return bulkAllocationLineErrorText(name, err);
  }
  // A chart that does not hold a required system account role is the other
  // case GENERIC_FAILURE answers badly. "The operation failed. Please try
  // again" invites a retry that cannot possibly succeed — the chart is the
  // same on the second call — and names nothing to fix. Production on
  // 2026-09-04 was missing `disposal_profit_loss` on all 13 companies, so
  // every asset disposal on every tenant returned exactly that.
  //
  // Handled HERE rather than in each tool because ~40 services resolve
  // system accounts and any of their tools can raise it; a per-tool catch
  // would cover whichever ones someone remembered. Nothing leaks: the role
  // name and the account codes are the company's own chart, and the message
  // carries no SQL and no stack. Still a throw, so the savepoint has
  // already unwound and the call is refunded and audited like any failure.
  if (err instanceof MissingSystemAccountError) {
    return missingSystemAccountText(name, err);
  }
  // A line whose sign contradicts the invoice it names is the third. The
  // refusal has to say WHICH way to go — drop invoice_id and it posts as a
  // refund — because "the operation failed" on a payload the agent believes
  // is a routine settlement invites the retry that keeps failing. Nothing
  // in the message but the caller's own transaction id.
  if (err instanceof BankLineDirectionError) {
    return bankLineDirectionErrorText(name, err);
  }
  // Any THROWN typed refusal (a code on REFUSAL_CODES) keeps its own message
  // — e.g. RECONCILED_CASH from bank reverse, reached by void_payment and
  // every reverse tool, which do not catch so the savepoint sees the throw.
  // The savepoint has rolled back; the text is caller-facing, no SQL. An
  // unclassified Error or a pg error still falls through to GENERIC_FAILURE.
  if (isRefusalCoded(err)) return err.message;
  const lockWait = lockWaitErrorText(name, err); // a raw 55P03 — see lockWaitError.ts
  if (lockWait) return lockWait;
  return GENERIC_FAILURE;
}
