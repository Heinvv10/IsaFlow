/**
 * Timing shared by the Netcash sender and the code that must not act while a send may still be running (AP-01).
 * Its own module so tests that replace netcashService do not lose the constants.
 */

/** A request to Netcash is aborted after this long (netcashService.fetchWithTimeout). */
export const REQUEST_TIMEOUT_MS = 30_000;

/**
 * A claim is 'pending' from its commit until the settle, which is the send (at most REQUEST_TIMEOUT_MS) plus a margin
 * for a slow database or a paused process (the settle reuses the claim's connection: no pool checkout). Younger than
 * this, a pending claim may be a send in flight whose send lock went with a dead connection, and nothing may release
 * it; older, with no send lock held, its sender is presumed gone (resolve).
 */
export const SEND_WINDOW_MS = REQUEST_TIMEOUT_MS + 90_000;

/**
 * How long a submit waits for the claim's pooled connection (AP-01 round 11). Past it the submit is refused 503 with
 * nothing claimed or sent: a pool busy enough to make a send wait is not one to hold a connection in for 30 s more.
 */
export const CLAIM_CONNECTION_TIMEOUT_MS = 2_000;

/**
 * Bounds on the settle - recording Netcash's answer - on the claim connection and on the retry (AP-01 round 12). A
 * settle that stalls (a row held by someone else, a connection that stopped answering) would otherwise hold its send
 * slot for good. lock_timeout and statement_timeout are tightened in the settle transaction (never loosened); the
 * client gives up after SETTLE_QUERY_TIMEOUT_MS, ABOVE the statement bound so the server always stops first when it
 * can still hear us.
 */
export const SETTLE_LOCK_TIMEOUT_MS = 2_000;
export const SETTLE_STATEMENT_TIMEOUT_MS = 4_000;
export const SETTLE_QUERY_TIMEOUT_MS = SETTLE_STATEMENT_TIMEOUT_MS + 2_000;

/**
 * Cheap statements (BEGIN, SET LOCAL, set_config, savepoints) are given up on sooner than SETTLE_QUERY_TIMEOUT_MS -
 * 2 s, not 1 (round 14): this box has run at load 95+, where a 1 s bound tripped on statements that were only slow.
 */
export const CHEAP_QUERY_TIMEOUT_MS = 2_000;

/**
 * One settle attempt, all its statements together, gets at most this long (round 13): each statement's client timeout
 * is what is left of it. With the send and both attempts this keeps the settle chain well inside SEND_WINDOW_MS
 * (tests/unit/services/ap/netcashSettleBudget.test.ts holds it to 75%).
 */
export const SETTLE_ATTEMPT_BUDGET_MS = 8_000;

/**
 * The detached settler (netcashLateSettler, round 13) keeps trying to record an answer both bounded attempts could not,
 * backing off from LATE_SETTLE_FIRST_DELAY_MS to LATE_SETTLE_MAX_DELAY_MS, for NETCASH_LATE_SETTLE_TOTAL_MS (default
 * 10 minutes) in all.
 */
export const LATE_SETTLE_FIRST_DELAY_MS = 1_000;
export const LATE_SETTLE_MAX_DELAY_MS = 30_000;
export const DEFAULT_LATE_SETTLE_TOTAL_MS = 600_000;

/**
 * The durable record of an answer the settle could not write (netcashUnrecordedAnswer, round 14) runs before the 500
 * too: its checkout and its attempt are bounded like a settle's, and they count in the settle budget (round 15).
 */
export const UNRECORDED_ANSWER_CHECKOUT_MS = CLAIM_CONNECTION_TIMEOUT_MS;
export const UNRECORDED_ANSWER_BUDGET_MS = 8_000;

/**
 * The sender-side fence (netcashSendFence, residual 3b): a send is issued only if at most this long has passed, on a
 * monotonic clock, since before its claim transaction began. Resolve frees a pending claim whose send lock is gone only
 * once it is SEND_WINDOW_MS old, on the assumption that a send started by then has ended - true of a live process, not
 * of a PAUSED one. A send that starts by this deadline ends by this deadline + REQUEST_TIMEOUT_MS, and
 * tests/unit/services/ap/netcashSettleBudget.test.ts holds that to half of SEND_WINDOW_MS (the rest is margin for the
 * two clocks' rates, the network and scheduling): 30 s + 30 s = 60 s of 120 s. A normal send starts within
 * milliseconds; the deadline is generous because a refused send only has to be tried again, and a box at load 95+ is
 * slow enough to need seconds for the claim's checkout (<= CLAIM_CONNECTION_TIMEOUT_MS) and statements.
 */
export const SEND_START_DEADLINE_MS = 30_000;

/**
 * The local spool of an answer that neither the settle nor audit_log could record (netcashAnswerSpool, residual 3a): its
 * write (open, append, fsync, close) is given up on after this long so the 500 is never held up by a sick disk. It
 * counts in the settle budget (netcashSettleBudget.test.ts).
 */
export const ANSWER_SPOOL_TIMEOUT_MS = 2_000;

/**
 * The spool replay (netcashAnswerSpoolReplay) is bounded per call - resolve awaits it: at most this many entries, and no
 * new entry started past this long; the rest waits for the next call (and still blocks its submission meanwhile). An
 * entry the database refuses for its own content (a deleted company or user) is quarantined after this many refusals.
 */
export const SPOOL_REPLAY_MAX_ENTRIES = 10;
export const SPOOL_REPLAY_BUDGET_MS = 15_000;
export const SPOOL_QUARANTINE_AFTER_FAILURES = 3;
