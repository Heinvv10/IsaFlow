/**
 * Shared helpers for MCP tool handlers. Keep tiny and dependency-free —
 * every tool file uses these to build results and sanitise inputs.
 */
import type { McpToolResult } from '../types';
import { UUID_RE, hasNul, isRealCalendarDate, NUL_MESSAGE } from '@/lib/validation';
import { SYSTEM_ROLE_REFUSAL_CODES } from './systemRoleRefusalCodes';

export function ok(data: unknown): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

/** Generic error result. NEVER include tenant hints or internals — a
 *  cross-tenant probe must read identically to a genuine miss. */
export function toolError(text: string): McpToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

export const NOT_FOUND = 'Not found';

/** A tool error when any string argument (deep) holds a NUL byte, which Postgres text cannot store. Null otherwise. */
export function nulArgError(args: Record<string, unknown>): McpToolResult | null {
  return hasNul(args) ? toolError(`invalid arguments: ${NUL_MESSAGE}`) : null;
}

export function strArg(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

export function clampLimit(args: Record<string, unknown>, fallback: number, max: number): number {
  const v = Number(args.limit);
  if (!Number.isFinite(v) || v <= 0) return fallback;
  return Math.min(Math.floor(v), max);
}

/**
 * Arguments that end up inside a SQL cast or a date comparison.
 *
 * An agent's id lands as `$n::UUID` and its date as `$n::DATE`, and being a
 * non-empty string is not enough: 'abc' throws 22P02, 'junk' and '2026-02-31'
 * throw 22008. A READ tool runs with NO savepoint (registry.ts), so either
 * aborts the whole request transaction — the registry's own refund and audit
 * writes then fail with 25P02 and the caller gets a 500 with the Flow debit
 * unrefunded. A WRITE tool has a savepoint, so the transaction survives, but
 * the reply degrades to a generic failure that tells the agent nothing about
 * which argument it got wrong.
 *
 * `format: date` in a JSON Schema is advisory — nothing in this server
 * enforces it — so these are the only checks standing between an agent's
 * typo and a cast.
 *
 * Note `isRealCalendarDate`, not `isValidDate`: Date.parse rolls '2026-02-31'
 * forward to 3 March and returns a timestamp, while Postgres throws on it.
 */
export interface CastableArgs {
  /** Checked against UUID_RE, in order. */
  uuid?: readonly string[];
  /** Checked against isRealCalendarDate, in order. */
  date?: readonly string[];
}

/**
 * Returns a `toolError('invalid <arg>')` for the FIRST argument that cannot
 * survive its cast, or null when everything is usable. Absent arguments pass —
 * requiredness is the caller's own check, and its message is more specific.
 *
 * Naming the argument leaks nothing: it is the agent's own input, and whether
 * a string is a well-formed UUID says nothing about whether a row exists.
 */
export function guardCastableArgs(
  args: Record<string, unknown>,
  spec: CastableArgs,
): McpToolResult | null {
  const message = castableArgError(args, spec);
  return message === null ? null : toolError(message);
}

/**
 * The same check as `guardCastableArgs`, as a bare message.
 *
 * A bulk tool validates one ELEMENT at a time and has to prefix the refusal
 * with that element's index before it becomes the reply, which it cannot do
 * once the message is sealed inside an `McpToolResult`.
 */
export function castableArgError(
  args: Record<string, unknown>,
  spec: CastableArgs,
): string | null {
  for (const key of spec.uuid ?? []) {
    const value = strArg(args, key);
    if (value !== undefined && !UUID_RE.test(value)) return `invalid ${key}`;
  }
  for (const key of spec.date ?? []) {
    const value = strArg(args, key);
    if (value !== undefined && !isRealCalendarDate(value)) return `invalid ${key}`;
  }
  return null;
}

/**
 * Same guard for a list of ids (`transaction_ids`, journal line `account_id`s).
 *
 * Names the offending ELEMENT, not the array: a 200-id batch rejected as
 * "invalid transaction_ids" tells an agent only that one of two hundred is
 * wrong, which it then has to bisect. `labelAt` builds the position — indices
 * must be those of the array the AGENT sent, so validate before any filtering.
 *
 * The value is echoed back because it is the agent's own input (nothing of
 * ours leaks through it), truncated so a pathological string cannot bloat the
 * reply.
 */
export function guardUuidList(
  values: readonly unknown[],
  labelAt: (index: number) => string,
): McpToolResult | null {
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (typeof value !== 'string' || !UUID_RE.test(value)) {
      return toolError(`invalid ${labelAt(i)}: ${JSON.stringify(truncateForMessage(value))}`);
    }
  }
  return null;
}

const MAX_ECHOED_CHARS = 48;

/** Echo an agent's bad value back readably without letting it bloat the reply. */
function truncateForMessage(value: unknown): string {
  const text = typeof value === 'string' ? value : String(value);
  return text.length > MAX_ECHOED_CHARS ? `${text.slice(0, MAX_ECHOED_CHARS)}…` : text;
}

/**
 * The codes this codebase's own refusal classes carry — the complete set of
 * `readonly code = '…'` declarations under `src/`, kept in sync by
 * `tests/unit/mcp/typedRefusalReachesAgent.test.ts`, which fails when a new one
 * is declared and not listed here.
 *
 * An ALLOWLIST, not a shape test. A shape test asked "does this code look like
 * ours" and admitted anything SCREAMING_SNAKE that reached the boundary —
 * Node's own error codes are exactly that (`ERR_INVALID_ARG_TYPE`,
 * `ERR_OUT_OF_RANGE`, undici's `UND_ERR_*`), and each carries an internal
 * message naming arguments and received values. A `code` an attacker can
 * influence would have passed too. Identity closes the class; shape only
 * narrowed it.
 *
 * Failing closed here costs a new refusal class its wording until it is added,
 * which the census test surfaces the moment it is written.
 */
const REFUSAL_CODES: ReadonlySet<string> = new Set([
  'ADJUSTMENT_NOT_APPROVABLE',
  'APPROVAL_REQUEST_LOCK_TIMEOUT',
  // R-035 approval gate (gl/approvalGate): names the caller's own document
  // number, the demanded role and the rule's name; raised before any write.
  'APPROVAL_REQUIRED',
  'BANK_ALLOCATION_REFUSED',
  'BANK_MATCH_UNAVAILABLE',
  'BANK_TX_ALLOCATED',
  'BANK_TX_LOCK_TIMEOUT',
  'BANK_TX_NOT_POSTED',
  // Listed because every `readonly code` must be; no MCP tool reverses or
  // processes a batch yet, so no agent can receive it today.
  'BATCH_ALREADY_REVERSED',
  'BATCH_NOT_PROCESSABLE',
  'BILL_LINE_ACCOUNT_REFUSED',
  // A captured document already claimed for posting, or rejected (K-072), or its
  // file already posted from another upload / held by another request (R-088).
  // Four fixed messages naming no id, amount or table, raised only after the
  // service read the document by company_id — the caller's own document.
  'CAPTURED_DOCUMENT_ALREADY_POSTED',
  'CAPTURE_EVENT_LOCKED',
  // Another request holds the capture row (K-072): says "retry", names only the
  // id the caller passed, and the row is locked by id AND company_id.
  'CAPTURE_ROW_LOCK_TIMEOUT',
  // A manual expense-claim line's source document could not be claimed (R-105,
  // R-088). Eight fixed messages naming no id, amount or table, raised before any write;
  // the claim is scoped by company_id. No MCP tool creates expense claims today.
  'CLAIM_SOURCE_DOCUMENT_REFUSED',
  // R-161 client group fence: names only the id the caller passed; raised before any write.
  'CLIENT_GROUP_NOT_FOUND',
  'CREDIT_NOTE_LOCK_TIMEOUT',
  'CUSTOMER_INVOICE_LOCK_TIMEOUT',
  'CUSTOMER_NOT_FOUND',
  // R-035: approve on a request whose document changed since it was raised.
  // Names only the request id the caller passed; nothing is written.
  'DOCUMENT_CHANGED',
  'DOCUMENT_CLAIM_LOCK_TIMEOUT',
  // Inactive or not-this-company line account (gl/documentLineAccountGuard): names only the caller's own account.
  'DOCUMENT_LINE_ACCOUNT_REFUSED',
  'DOCUMENT_NUMBER_LOCK_TIMEOUT',
  // R-035 review HIGH-1 (ap/supplierInvoiceCurrency): names the currency and
  // the rate the caller sent; raised before any write.
  'EXCHANGE_RATE_INVALID',
  // R-035: approve without the digest the approver was shown. Names only the request id.
  'EXPECTED_DIGEST_REQUIRED',
  'GL_ACCOUNT_LOCK_TIMEOUT',
  // Confirming a manual journal as the correction of an auto-posted line was
  // refused (R-079). Twelve fixed messages written for the user, naming no id,
  // amount or table, raised before any write. No MCP tool reaches it today.
  'HAND_CORRECTION_REFUSED',
  'JOURNAL_REVERSAL_LOCK_TIMEOUT',
  'LOAN_POST_LOCK_TIMEOUT',
  // R-035: enabling approval enforcement for a type not yet wired. Names only the type.
  'NOT_ENFORCEABLE',
  'PAYMENT_LOCK_TIMEOUT',
  'PAYMENT_POSTED_DURING_VOID',
  'PAYROLL_LOAN_LOCK_TIMEOUT',
  'PAYROLL_RUN_JOURNAL_POSTED',
  // W3-01 round 6: the payroll reversal guard's 5s wait ran out (payrollJournalReversalGuard).
  'PAYROLL_RUN_LOCK_TIMEOUT',
  // R-073 practice client fence: names only the id the caller passed; raised before any write.
  'PRACTICE_CLIENT_NOT_FOUND',
  // Another request is posting a document with the same content (R-088): one
  // fixed "retry" sentence naming no document, raised before any write.
  'RECEIPT_POST_BUSY',
  'RECEIPT_REFUSED',
  'RECLASS_LINE_LOCK_TIMEOUT',
  // Rematch of a statement already marked reconciled (R-059 r11). The message
  // names no id, amount or table, and the service reads the statement by
  // company_id, so it can only ever describe the caller's own statement.
  // Bank reverse (and void_payment through it) on cash a completed or Sage
  // reconciliation holds — R-111. Pre-write, caller-facing.
  'RECONCILED_CASH',
  'RECONCILIATION_CLOSED',
  'RECURRING_INVOICE_LOCK_TIMEOUT',
  'RECURRING_INVOICE_NOT_DUE',
  'RECURRING_INVOICE_TEMPLATE_INVALID',
  'RECURRING_JOURNAL_LOCK_TIMEOUT',
  'RECURRING_JOURNAL_NOT_FOUND',
  'RECURRING_TEMPLATE_LINE_ACCOUNT',
  'RECURRING_TEMPLATE_LOCK_TIMEOUT',
  'RECURRING_TEMPLATE_NOT_DUE',
  'RECURRING_TEMPLATE_TOTALS_MISMATCH',
  'REVERSAL_BEFORE_ORIGINAL', // R-012: names only the caller's entry date and today; pre-write.
  'ROW_LOCK_TIMEOUT', // D8 round 9 (core/rowLockBudget): names the document; nothing acquired, retry.
  'RULE_AUTHORITY_REQUIRED',
  // A refund larger than the contact's on-account credit (migration 681). One fixed sentence written for the user, naming the contact, the two amounts
  // and the as-at date the caller itself supplied — no id, no table — and
  // raised BEFORE the journal posts, so there is nothing written to leak.
  'SUPPLIER_REFUND_REFUSED',
  'SUPPLIER_INVOICE_LOCK_TIMEOUT',
  'SUPPLIER_NOT_FOUND',
  'SUPPLIER_PAYMENT_NOT_FOUND',
  'SUPPLIER_PAYMENT_NOT_PROCESSABLE',
  'SUPPLIER_PAYMENT_REFUSED',
  ...SYSTEM_ROLE_REFUSAL_CODES,
  'TAX_DIRECTIVE_ALREADY_APPLIED',
  'TIME_ENTRIES_NOT_CLAIMED',
  'TIME_ENTRY_LOCK_TIMEOUT',
  // VAT adjustment approve/cancel refusals (reports/vatAdjustmentService): not found, not draft, contended.
  'VAT_ADJUSTMENT_REFUSED',
  // Mark/unmark "VAT declared outside IsaFlow" refused: not owner/admin,
  // blank reason, document not found, or not currently marked (unmark) —
  // reports/vatDeclaredElsewhereService. Names no id/amount/table beyond the
  // caller's own document, scoped by company_id. Pre-write.
  'VAT_DECLARED_ELSEWHERE_FORBIDDEN',
  'VAT_DECLARED_ELSEWHERE_REFUSED',
  // R-032 L5: an approve/post/file/close act refused to a platform-admin
  // "Login as" session (auth/impersonationGuard). A fixed message naming no
  // id, amount or table; raised as the approving service's first statement,
  // before any read or write. Bearer callers carry no session id and are not
  // refused today — listed because every `readonly code` must be decided.
  'IMPERSONATION_FORBIDDEN',
  // R-035 review HIGH-2 (gl/approvalGateExempt): names the demanded role and the
  // caller's own; raised before an import writes anything.
  'IMPORT_APPROVAL_AUTHORITY_REQUIRED',
  // Link/unlink a captured document to a posted journal refused: blank
  // reason, journal not found/not posted/reversed, document not found, or
  // the document already backs another claim (gl/journalDocumentLinkService,
  // VAT-gaps batch item 1). Names no id/amount beyond the caller's own
  // journal/document, scoped by company_id. Pre-write.
  'JOURNAL_DOCUMENT_LINK_REFUSED',
  // The exclusive VAT-lock key was not free within 5s (posts in flight).
  // Says "retry"; raised before any write.
  // Blocking VAT exceptions refused a lock/mark-submitted with no override, or
  // an override reason from a non-owner/admin (reports/vatGateOverrideService).
  // Names only the caller's own exception counts; pre-write.
  'VAT_GATE_BLOCKED',
  'VAT_GATE_OVERRIDE_FORBIDDEN',
  'VAT_LOCK_TIMEOUT',
  // A journal that moves a VAT-return figure, dated inside a locked (filed) VAT
  // period (gl/journalVatLockGuard). The message names the caller's own period
  // dates and the remedy — no id, amount or table — and is raised before the
  // write that would post.
  'VAT_PERIOD_LOCKED',
  // Lock/unlock of a VAT period refused (reports/vatPeriodLockBounds): a
  // future end, a span over 12 months, an overlap naming the caller's own
  // locked period, a blank unlock reason. Pre-write, no id or table named.
  'VAT_PERIOD_LOCK_REFUSED',
  'WIP_ENTRIES_LOCKED',
  'WRITE_OFF_NOT_APPROVABLE',
]);

/**
 * Declared codes that are NOT refusals, and must stay behind the fallback.
 *
 * `ClaimOutsideTransactionError` marks a programmer error — a claim attempted
 * outside a request transaction — not something the caller did or can remedy.
 * Its message names internal machinery (`withAuth` / `als.run`), so an agent
 * told it would retry against advice it cannot act on.
 *
 * The census in `tests/unit/mcp/typedRefusalReachesAgent.test.ts` requires
 * every declared code to appear in EXACTLY ONE of these two sets, so a new
 * coded error is a decision rather than a default disclosure.
 */
export const NOT_A_REFUSAL_CODES: ReadonlySet<string> = new Set([
  'CLAIM_OUTSIDE_TRANSACTION',
]);

/**
 * Surface a service error's message ONLY when it is an application-level
 * refusal this codebase raised itself. Everything else — pg SQLSTATEs, driver
 * and library errors, anything carrying a `code` we do not own — returns the
 * generic fallback, because their text can carry schema names, file paths and
 * argument values.
 *
 * "No `code` at all" is NOT the test, and used to be: the services now raise
 * their refusals as typed classes carrying a NAMED code
 * (`SUPPLIER_PAYMENT_REFUSED`, `BANK_ALLOCATION_REFUSED`, `RECEIPT_REFUSED`),
 * and the old predicate read every one of them as a driver error and replaced
 * the remedy with the fallback. An agent that is told "Could not apply this
 * payment." instead of "Invoice INV-9 is cancelled and cannot receive a
 * payment." retries the same call. A code-less `Error` is still surfaced: those
 * are the codebase's own `throw new Error(...)` messages, written to be read.
 */
/**
 * A THROWN error carrying one of the named refusal codes above. The registry
 * answers these with their own message (they are caller-facing and carry no
 * SQL); anything else — a code-less Error, a pg SQLSTATE — stays GENERIC there.
 */
export function isRefusalCoded(err: unknown): err is Error {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && REFUSAL_CODES.has(code);
}

export function safeErrorText(err: unknown, fallback: string): string {
  if (!(err instanceof Error)) return fallback;
  const code = (err as { code?: unknown }).code;
  if (code === undefined) return err.message;
  return typeof code === 'string' && REFUSAL_CODES.has(code) ? err.message : fallback;
}

/**
 * The largest magnitude a NUMERIC(15,2) column holds: 13 integer digits and 2
 * decimals. Anything beyond it is a numeric overflow (22003) at the INSERT.
 */
export const MAX_MONEY = 9999999999999.99;

/**
 * Is `amount` exactly representable as whole cents, and small enough to store?
 *
 * Money is NUMERIC(15,2). A third decimal would be rounded by Postgres, so the
 * agent's own arithmetic and the ledger's would disagree silently — but the
 * obvious guard, `Math.round(amount * 100) !== amount * 100`, is itself wrong:
 * `282543.34 * 100` is `28254334.000000004` in IEEE-754, so a real receipt of
 * R282,543.34 was refused as "more than two decimal places". That blocked a
 * production AR reload (Velocity Fibre, 2026-09-05).
 *
 * Comparing the two-decimal rendering back to the number is exact wherever
 * `toFixed` renders positional digits, where a fixed epsilon on `amount * 100`
 * is not: past 1e13 the spacing between doubles already exceeds a cent.
 *
 * The magnitude bound is not decoration. `toFixed` switches to EXPONENTIAL
 * notation at 1e21 (`(1e21).toFixed(2) === '1e+21'`), which parses back equal
 * and so passes the cents test; and a 14-digit amount is representable but
 * still overflows the column. Without the bound both reach Postgres and fail as
 * a raw 22003 mid-write, where the whole point of validating here is that every
 * refusal happens BEFORE the first write.
 */
export function hasWholeCents(amount: number): boolean {
  if (!Number.isFinite(amount) || Math.abs(amount) > MAX_MONEY) return false;
  return Number(amount.toFixed(2)) === amount;
}
