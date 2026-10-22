/**
 * The sender-side fence (AP-01 residual 3b). A claim whose send lock is gone (its connection died) may be freed by an
 * operator once it is SEND_WINDOW_MS old, and a newer claim may then send the batch. If the old sender's PROCESS was
 * paused (SIGSTOP, a starved process) meanwhile, it would wake and send too: paid twice. So the sender takes a timestamp
 * BEFORE its claim transaction begins and, immediately before the request, refuses to send when more than
 * SEND_START_DEADLINE_MS have passed. The clock is monotonic (performance.now: CLOCK_MONOTONIC on Linux), which keeps
 * running while a process is SIGSTOPped or starved and which NTP cannot step - Date.now() can be stepped. It does NOT
 * run while the whole host is suspended (or a VM frozen from outside): after that the database's wall clock has moved
 * on and this one has not, so a suspend of the machine is outside what the fence covers. Taken before the claim, the
 * fence's origin is never later than the claim's created_at, which is what resolve measures the window from.
 *
 * Residual (netcash/.claude.md): a pause AFTER the fence passes and before the request's bytes leave the socket.
 */
import { SEND_START_DEADLINE_MS } from './netcashTimeouts';

export interface SendFence {
  /** Whole milliseconds since the fence was taken, on the monotonic clock. */
  elapsedMs(): number;
  /** true while a send may still be started. Synchronous: call it as the last step before the request is issued. */
  mayStart(): boolean;
}

/** Take the fence now: call before the claim transaction begins (netcashSubmissionClaim.claimBatch). */
export function startSendFence(): SendFence {
  const startedAt = performance.now();
  const elapsedMs = () => Math.round(performance.now() - startedAt);
  return { elapsedMs, mayStart: () => elapsedMs() <= SEND_START_DEADLINE_MS };
}
