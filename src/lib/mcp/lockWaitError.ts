/**
 * What an MCP tool call answers when it failed on a raw 55P03 — a lock wait that hit its `lock_timeout`.
 *
 * Since migration 858 the usual source is the company+year NUMBER lock: every tool that posts a journal or creates a
 * credit note, receipt or supplier payment numbers it under that lock, bounded at 5 s inside the numbering trigger,
 * and a peer transaction that numbered something for the same company and year holds it to its commit. The
 * registry's savepoint has already rolled the call back, and the identical call succeeds once the peer commits — so
 * the answer says that, where GENERIC_FAILURE ("the operation failed") would not. No driver text, no SQL.
 */
import { isLockNotAvailable, isDeadlockDetected } from '@/modules/accounting/services/core/lockContention';
import { log } from '@/lib/logger';

export function lockWaitErrorText(toolName: string, err: unknown): string | null {
  if (!isLockNotAvailable(err)) return null;
  return `${toolName}: another request is holding a record or a document number this call needs — `
    + 'nothing was written; retry in a moment.';
}

/**
 * A raw 40P01: Postgres chose this call's transaction as the victim of a deadlock. The registry's savepoint has
 * rolled the call back, so nothing was written and the identical call succeeds on its own. The usual cause is a
 * JSON-RPC batch (one transaction for all its calls) that holds one lock while it asks for another in the opposite
 * order of a second batch; the text does not claim that, because any two requests can do it. The driver error is
 * logged here, never shown: its text names processes and relations.
 */
export function deadlockErrorText(toolName: string, err: unknown): string | null {
  if (!isDeadlockDetected(err)) return null;
  log.warn('MCP tool call was the victim of a deadlock (40P01)', {
    tool: toolName, error: err instanceof Error ? err.message : String(err),
  }, 'mcp');
  return `${toolName}: another request holds locks this one needs (deadlock) — nothing was written; `
    + 'retry in a moment (inside a batch, send this call in its own request).';
}
