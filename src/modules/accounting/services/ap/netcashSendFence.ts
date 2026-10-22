/**
 * The sender-side fence (AP-01 residual 3b). A claim whose send lock is gone (its connection died) may be freed by an
 * operator once it is SEND_WINDOW_MS old, and a newer claim may then send the batch. If the old sender's PROCESS was
 * paused (SIGSTOP, a frozen VM) meanwhile, it would wake and send too: paid twice. So the sender takes a timestamp
 * BEFORE its claim transaction begins and, immediately before the request, refuses to send when more than
 * SEND_START_DEADLINE_MS have passed. The clock is monotonic (performance.now: CLOCK_MONOTONIC), which keeps running
 * while a process is stopped and which NTP cannot step - Date.now() is neither. Taken before the claim, the fence's
 * origin is never later than the claim's created_at, which is what resolve measures the window from.
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
