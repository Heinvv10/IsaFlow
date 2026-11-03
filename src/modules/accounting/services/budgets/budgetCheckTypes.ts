/**
 * Budget check at approval (budgets P5 spec §3b/§3c, census findings 1-6): the shared types and the
 * typed refusals. No I/O, so the pure core, the services and the routes can all import it.
 */
import type { RemainingGrain } from './remainingBudgetCore';

export type BudgetPolicy = 'off' | 'warn' | 'block';
export type BudgetChannel = 'ui' | 'bulk' | 'mcp' | 'system';
export type BudgetOutcome = 'pass' | 'warn' | 'override' | 'refused';
export type BudgetDocumentType = 'supplier_invoice' | 'purchase_order';

/**
 * How a caller stands to the company budget lock (`budget_check:<company>`, spec §3c):
 * - `take`: nothing is locked yet; the service takes it itself FIRST (before the document lock) when
 *   the policy is `block`. UI single approve, MCP single approve.
 * - `held`: the caller opened the gate once before its loop, outside any per-item savepoint (bulk
 *   route, MCP bulk tool; census finding 6) and passes it in `gate`.
 * - `none`: the caller already holds document locks, so it cannot take the company lock first
 *   (capture auto-approve, recurring auto-post; census T2 exceptions). The check runs lock-free:
 *   in `block` mode it still refuses an over-budget document, but two such approvals racing each
 *   other can both pass (named residual race, documented in `ap/.claude.md`).
 */
export type BudgetLockMode = 'take' | 'held' | 'none';

export interface BudgetGate {
  /** The policy read when the gate was opened; null when the gate never read it (`none`). */
  policy: BudgetPolicy | null;
  /** Whether this transaction holds the company budget lock. */
  locked: boolean;
  mode: BudgetLockMode;
}

export interface BudgetCheckContext {
  channel: BudgetChannel;
  lock: BudgetLockMode;
  /** The person's reason (UI single, or a bulk batch's one reason). Blank counts as none. */
  reason?: string | null;
  /** Owner/admin override of a block refusal: UI single approve only. */
  override?: boolean;
  /** The caller's company role (owner, admin, manager, …); decides who may override. */
  actorRole?: string | null;
  /** Required for `held`: the gate the caller opened before its loop. */
  gate?: BudgetGate;
  /**
   * False when the caller may not see budget figures (an MCP token without read:reports): refusals and
   * warnings name the over lines (account, slice, month) without remaining or amounts. Default true.
   */
  figures?: boolean;
}

/** One budget slice the document hits, with the document's own amount on it. */
export interface BudgetCheckLine {
  glAccountId: string;
  /** 'YYYY-MM' (decision 8b: a bill's invoice_date month). */
  month: string;
  /** The account's grain in the primary version; null = no budget for the account (or no version). */
  grain: RemainingGrain | null;
  /** The slice (grain dims only) when budgeted; the line's own dims otherwise. */
  cc1Id: string | null;
  cc2Id: string | null;
  buId: string | null;
  /** The line lacks the grain's dimension: the unassigned slice, "No budget". */
  unassigned: boolean;
  budget: number | null;
  actual: number;
  committed: number;
  remaining: number | null;
  /** This document's ex-VAT amount on the slice (the lines approve posts, summed). */
  amount: number;
  over: boolean;
  accountLabel: string;
  sliceLabel: string;
}

export interface BudgetCheckResult {
  policy: BudgetPolicy;
  outcome: BudgetOutcome | null;
  lines: BudgetCheckLine[];
  /** One sentence per over-budget line, for warn-mode callers (bulk, MCP, system). */
  warnings: string[];
}

/** What a refused check records once the caller's savepoint has rolled back (census finding 4). */
export interface BudgetRefusalEvent {
  companyId: string;
  documentType: BudgetDocumentType;
  documentId: string;
  documentRef: string;
  policy: BudgetPolicy;
  lines: BudgetCheckLine[];
  reason: string | null;
  channel: BudgetChannel;
  actorId: string;
}

/** 409: the policy is `block` and at least one line is over its remaining budget. */
export class BudgetExceededError extends Error {
  readonly code = 'BUDGET_EXCEEDED';
  readonly status = 409;
  constructor(message: string, readonly event: BudgetRefusalEvent, readonly overrideRefused = false) {
    super(message);
    this.name = 'BudgetExceededError';
  }
  get overLines(): BudgetCheckLine[] {
    return this.event.lines.filter((l) => l.over);
  }
}

/** 400: a person approving in the UI must give a reason (warn over budget, or an override). Nothing is written. */
export class BudgetReasonRequiredError extends Error {
  readonly code = 'BUDGET_REASON_REQUIRED';
  readonly status = 400;
  constructor(message: string, readonly lines: BudgetCheckLine[]) {
    super(message);
    this.name = 'BudgetReasonRequiredError';
  }
}

/**
 * 503 + Retry-After (a `*_LOCK_TIMEOUT` code, so every route, the bulk loops and the capture
 * contention rule treat it as a held row): the company budget lock was not held in time. Either the
 * bounded wait ran out, or (`policyChanged`) the policy became `block` after this approval decided,
 * from its first read, not to take the lock: it cannot take it now without reversing the lock order.
 * Raised before any write; the retry reads `block` first and takes the lock.
 */
export class BudgetCheckLockTimeoutError extends Error {
  readonly code = 'BUDGET_CHECK_LOCK_TIMEOUT';
  constructor(readonly policyChanged = false) {
    super(policyChanged
      ? 'The budget check policy changed to block while this approval was running — retry in a moment.'
      : 'Budget checks for this company are busy with another approval — retry in a moment.');
    this.name = 'BudgetCheckLockTimeoutError';
  }
}

export const BUDGET_REASON_MAX = 2000;

export const isBudgetPolicy = (v: unknown): v is BudgetPolicy => v === 'off' || v === 'warn' || v === 'block';
