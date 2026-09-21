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
 * issued), pending approval (not yet issued either — Hein, R-082 round 2,
 * 2026-09-11), or cancelled (voided). Every other status — including 'paid' —
 * is IN: an invoice paid TODAY was outstanding on every earlier date, and
 * filtering to the open set is what erased settled debt from historical
 * ageing (see src/lib/constants/invoiceStatuses.ts for why the ageing is
 * exempt from the live open-status sets).
 *
 * PENDING_APPROVAL. Both `customer_invoices_status_check` and
 * `supplier_invoices_status_check` spell it identically, so one clause
 * covers both aliases — no dual spelling to handle. A pending-approval
 * document is absent from the ageing, the subledger and a statement; once
 * approved it reappears on every routed surface, at the date it was always
 * dated for (the as-at cutoff is unaffected — this is still only the status
 * predicate).
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
 *
 * A JS TWIN, `documentInPopulation`, for callers that already have the row in
 * hand and classify it into a report's own `excluded` bucket rather than
 * filtering it out of the query (R-082 round 2) — the same three statuses,
 * so the two can never drift relative to each other.
 */

import type { InvoiceAlias } from './softDeleteLedgerPresence';

/** Statuses that put a document OUTSIDE the population. The one list both twins read. */
const EXCLUDED_STATUSES = ['draft', 'pending_approval', 'cancelled'] as const;

/** TRUE when the document's status puts it in the ageing's population. */
export function documentInPopulationExpr(alias: InvoiceAlias): string {
  const list = EXCLUDED_STATUSES.map((s) => `'${s}'`).join(', ');
  return `COALESCE(${alias}.status, '') NOT IN (${list})`;
}

/** The JS twin of {@link documentInPopulationExpr}, for a row already in hand. */
export function documentInPopulation(status: string | null | undefined): boolean {
  return !(EXCLUDED_STATUSES as readonly string[]).includes(status ?? '');
}
