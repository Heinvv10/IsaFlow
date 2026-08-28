/**
 * A batch write that failed on ONE identifiable line.
 *
 * `registry.call()` answers every handler throw with GENERIC_FAILURE — "The
 * operation failed. Please try again or contact support." That is the right
 * answer for a tool that writes one thing: nothing about the internals is safe
 * to hand back, and there is only one thing that could have gone wrong.
 *
 * It is the WRONG answer for a batch. A 124-line pilot batch failed on a single
 * already-allocated transaction and came back with no index, no id and no
 * cause; it was bisected by hand. So a per-line fault is thrown as this type,
 * carrying the line index and the transaction it names, and the registry
 * renders those two facts (never the SQL, never a stack).
 *
 * It is still a THROW, deliberately. The registry's savepoint rolls back only
 * on a throw — a `catch → toolError` returns normally, RELEASES the savepoint,
 * and the transport's HTTP 200 commits whatever earlier lines already posted.
 * The batch has to unwind; the only thing this class changes is what the agent
 * is told afterwards.
 *
 * Lives at the top of `src/lib/mcp` rather than under `tools/` because
 * `registry.ts` imports it, and the registry must not depend on a tool module.
 */
export class BulkAllocationLineError extends Error {
  /** Index into the caller's own `allocations` array — 0-based, as reported. */
  readonly index: number;
  readonly transactionId: string;
  /** The underlying failure's message, without the line prefix. */
  readonly detail: string;

  constructor(index: number, transactionId: string, detail: string) {
    // The prefix is in `message` too: this is what reaches the server log and
    // any generic `.message` reader, and there it has to stand on its own.
    super(`line ${index} (${transactionId}): ${detail}`);
    this.name = 'BulkAllocationLineError';
    this.index = index;
    this.transactionId = transactionId;
    this.detail = detail;
  }
}

/** The text a tool result carries for `err`. Never SQL, never a stack. */
export function bulkAllocationLineErrorText(
  toolName: string,
  err: BulkAllocationLineError,
): string {
  return `${toolName} line ${err.index} (${err.transactionId}): ${err.detail}`
    + ' — batch rolled back, nothing posted';
}
