/**
 * The STATUS half of "which documents are in the ageing" — one definition for
 * every surface that says it shares the ageing's or the subledger's population.
 *
 * R-059 rounds 4, 5 and 6 each fixed this rule in some sites and missed a
 * sibling that claimed the same population, and each miss surfaced as a figure
 * the reconciliation could not explain: a residual invented by a spelling. The
 * rule was re-typed in eighteen places, so it drifted in the nineteenth. It now
 * lives here, and a mutation of this one function turns every consumer's test
 * red (fix.md, round 6).
 *
 * THE RULE. A document is in the population unless it is a draft (never
 * issued) or cancelled (voided). Every other status — including 'paid' — is IN:
 * an invoice paid TODAY was outstanding on every earlier date, and filtering to
 * the open set is what erased settled debt from historical ageing (see
 * src/lib/constants/invoiceStatuses.ts for why the ageing is exempt from the
 * live open-status sets).
 *
 * NULL STATUS. `status` is nullable on both invoice tables, with DEFAULT
 * 'draft'. The bare `status NOT IN ('draft','cancelled')` evaluates to NULL for
 * a NULL status, and a WHERE drops the row — silently. This rule reads a NULL as
 * NOT a draft: someone overwrote the default. That is a JUDGEMENT, not a fact
 * the schema settles, and `COALESCE(status, 'draft')` is the defensible
 * alternative; it follows master's own K-091 precedent on sales-by-customer.
 * fix.md (R-059 round 5, LOW-1) carries the SQL that would settle it on
 * production. Changing the convention means changing it HERE, once.
 *
 * NOT THE WHOLE POPULATION. The as-at cutoff (invoice_date <= as-at) and the
 * dated soft-delete leg (softDeleteLedgerPresence) are separate, because each
 * caller applies them differently — a row filter, a CASE, a correlated EXISTS.
 * This is only the status predicate, which every caller applies identically.
 *
 * AN EXPRESSION STRING, like `effectivePaidExpr`, so it splices into a WHERE, a
 * CASE WHEN and a string-built predicate alike: `${sql.unsafe(documentInPopulationExpr('ci'))}`.
 * It carries no parameter — the alias is one of two literals, never input.
 */

import type { InvoiceAlias } from './softDeleteLedgerPresence';

/** TRUE when the document's status puts it in the ageing's population. */
export function documentInPopulationExpr(alias: InvoiceAlias): string {
  return `COALESCE(${alias}.status, '') NOT IN ('draft', 'cancelled')`;
}
