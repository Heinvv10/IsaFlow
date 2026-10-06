/**
 * What an MCP tool call answers when it failed on a raw 55P03 — a lock wait that hit its `lock_timeout`.
 *
 * Since migration 858 the usual source is the company+year NUMBER lock: every tool that posts a journal or creates a
 * credit note, receipt or supplier payment numbers it under that lock, bounded at 5 s inside the numbering trigger,
 * and a peer transaction that numbered something for the same company and year holds it to its commit. The
 * registry's savepoint has already rolled the call back, and the identical call succeeds once the peer commits — so
 * the answer says that, where GENERIC_FAILURE ("the operation failed") would not. No driver text, no SQL.
 */
import { isLockNotAvailable } from '@/modules/accounting/services/core/lockContention';

export function lockWaitErrorText(toolName: string, err: unknown): string | null {
  if (!isLockNotAvailable(err)) return null;
  return `${toolName}: another request is holding a record or a document number this call needs — `
    + 'nothing was written; retry in a moment.';
}
