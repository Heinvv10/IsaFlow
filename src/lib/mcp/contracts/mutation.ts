/**
 * Shared shape for every mutating MCP tool: `dry_run` and `idempotency_key`.
 *
 * `bulk_allocate_bank_transactions` can post thousands of journals in one call —
 * 4,319 went in on Brightsphere — and a wrong VAT default scales through all of
 * them unseen. A dry run that returns THE JOURNALS THAT WOULD POST turns that
 * from an irreversible batch into a review step.
 *
 * The idempotency contract is already settled and enforced by the registry
 * (`src/lib/mcp/registry.ts`, documented in `src/lib/mcp/.claude.md`). Nothing
 * here re-opens it. Two of its rules bind every new write tool:
 *
 *   1. A SUCCESS THAT WROTE NOTHING must set `wroteNothing: true` on the result,
 *      so the audit row stores a NULL key and the key stays free. A dry run
 *      always writes nothing. Store a dry run under the key and the real call
 *      that follows — same intent, same natural key — is served the preview
 *      forever.
 *   2. Only PRE-write validation may return `toolError`. Once a service that can
 *      write has been called, every failure RETHROWS, because the savepoint
 *      rolls back on a throw and not on a returned error.
 */
import type { DetailLevel } from './envelope';

/**
 * What a dry run returns. Uniform across every mutating tool, so an agent can
 * review a receipt application and a bulk allocation with the same code.
 */
export interface DryRunResult {
  /** Always true on a dry run. Callers assert on this, not on a message. */
  dryRun: true;
  /** The journals that WOULD post, in full. This is the point of the dry run. */
  journals: DryRunJournal[];
  /** Rows that would be skipped, and why — the data's fault, not the request's. */
  skipped: DryRunSkip[];
  /** Documents whose balances would change, with before and after. */
  effects: DryRunEffect[];
  /** Count of journals that would post. `journals.length` may be truncated; this is not. */
  journalsTotal: number;
  /** True when `journals` was capped for response size. */
  truncated: boolean;
}

export interface DryRunJournal {
  /** Posting date the journal would carry, YYYY-MM-DD. */
  date: string;
  description: string;
  /** Fiscal period the date falls in, or null when NO period covers it — a blocker. */
  fiscalPeriodId: string | null;
  lines: DryRunJournalLine[];
  /** Sum of debits, for a caller that wants to check the journal balances. */
  totalDebit: number;
  totalCredit: number;
}

export interface DryRunJournalLine {
  accountId: string;
  accountCode: string;
  accountName: string;
  debit: number;
  credit: number;
  /** The VAT treatment that would actually POST — not the code displayed in a UI. */
  vatTreatment?: string;
}

export interface DryRunSkip {
  id: string;
  /** Machine-stable code: `already_allocated`, `excluded`, `period_closed`. */
  reason: string;
  detail?: string;
}

export interface DryRunEffect {
  entityType: 'customer_invoice' | 'supplier_invoice' | 'bank_transaction' | 'gl_account';
  entityId: string;
  documentNumber?: string;
  field: string;
  before: number;
  after: number;
}

/**
 * JSON Schema fragment for the two arguments every mutating tool takes. Spread
 * into a tool's `inputSchema.properties`.
 *
 * `dry_run` defaults to FALSE, not true. A default-true dry run reads as a
 * safety improvement and is not one: an agent that ignores the reply believes it
 * posted, and the discrepancy surfaces at the next reconciliation instead of at
 * the call. The tool DESCRIPTION carries the obligation to dry-run first; the
 * default stays honest about what the call did.
 */
export const MUTATION_ARG_SCHEMA = {
  dry_run: {
    type: 'boolean',
    description:
      'Preview only. Returns the journals that would post, the documents whose balances would change, and the rows that would be skipped — and writes nothing. Run this first on any batch.',
  },
  idempotency_key: {
    type: 'string',
    description:
      'Caller-chosen key that makes a retry safe. Reusing a key returns the stored result of the original call instead of writing again. Required on every write.',
  },
} as const;

/** Every dry run MUST set this on its McpToolResult so the key is not consumed. */
export const DRY_RUN_WROTE_NOTHING = true as const;

/** Detail level a dry run reports at; dry runs are always `full`. */
export const DRY_RUN_DETAIL: DetailLevel = 'full';
