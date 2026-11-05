// src/modules/accounting/services/afs/managementPackSections.ts
// The management pack's section vocabulary: the one list of section keys and their printed labels,
// and the sentences a section prints when it has nothing of its own. Pure (no I/O, no React) so the
// generator, the PDF/DOCX renderers, the in-app viewer and the client portal all read the same words.

/** Key order is the settings screen's order; it must equal PACK_SECTION_ORDER (pinned by managementPackSectionOrder.test.ts). */
export const SECTIONS_META: Array<{ key: string; label: string }> = [
  { key: 'cover', label: 'Cover Page' },
  { key: 'ai_executive_summary', label: 'AI Executive Summary' },
  { key: 'kpi_scorecard', label: 'KPI Scorecard' },
  { key: 'income_statement', label: 'Income Statement' },
  { key: 'income_vs_budget', label: 'Income vs Budget' },
  { key: 'balance_sheet', label: 'Balance Sheet' },
  { key: 'cash_flow', label: 'Cash Flow' },
  { key: 'debtors_ageing', label: 'Debtors Ageing' },
  { key: 'creditors_ageing', label: 'Creditors Ageing' },
  { key: 'bank_reconciliation', label: 'Bank Reconciliation' },
  { key: 'revenue_analysis', label: 'Revenue Analysis' },
  { key: 'expense_analysis', label: 'Expense Analysis' },
  { key: 'budget_variance', label: 'Budget Variance' },
  { key: 'cash_flow_forecast', label: 'Cash Flow Forecast' },
  { key: 'vat_dashboard', label: 'VAT Dashboard' },
  { key: 'cfo_narrative', label: 'CFO Narrative' },
];

/** "some_key" -> "Some Key": only for a key SECTIONS_META does not know (a pack stored by a newer or older build). */
function readable(key: string): string {
  return key.split('_').filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/** The printed title of a section key, from SECTIONS_META. */
export function packSectionLabel(key: string): string {
  return SECTIONS_META.find((s) => s.key === key)?.label ?? readable(key);
}

/** Stored as the narrative when the AI call fails (packAiSummaryService). Never content: nothing prints or stores them as such. */
export const AI_SUMMARY_UNAVAILABLE = 'AI summary unavailable for this period.';
export const AI_COMMENTARY_UNAVAILABLE = 'AI commentary unavailable for this section.';

/** True for the failure sentences above, which older packs stored as if they were commentary. */
export function isAiPlaceholder(narrative: string | null | undefined): boolean {
  return narrative === AI_SUMMARY_UNAVAILABLE || narrative === AI_COMMENTARY_UNAVAILABLE;
}

/** What a section with no content prints, in place of a bare heading. */
export const EXECUTIVE_SUMMARY_MISSING = 'No executive summary could be generated for this period.';
export const SECTION_NOT_AVAILABLE = 'This section is not yet available in the management pack.';

/** Printed under a statement that has no account lines: the table alone would read as a broken one. */
export const NO_ACTIVITY = {
  income_statement: 'No income or expenses were posted in this period.',
  balance_sheet: 'No balances are held at this date.',
  cash_flow: 'No cash moved in this period.',
} as const;

/** Printed when a section's report could not be read; the real error is logged. */
export const STATEMENT_UNAVAILABLE = 'This statement could not be produced for this period.';

/** The row kinds a statement table may carry; the only values that ever reach a class attribute or a style lookup. */
const ROW_KINDS: readonly string[] = ['heading', 'line', 'subtotal', 'total'];

/** A stored row kind, or 'line': section content is free-form JSON (overrides are tenant-written), so an unknown value is a plain row. */
export function safeRowKind(kind: unknown): 'heading' | 'line' | 'subtotal' | 'total' {
  return typeof kind === 'string' && ROW_KINDS.includes(kind) ? (kind as 'heading' | 'line' | 'subtotal' | 'total') : 'line';
}

/**
 * A pack's sections in print order. The canonical order is SECTIONS_META's key order (which equals
 * PACK_SECTION_ORDER, pinned by managementPackSectionOrder.test.ts); packs stored before the generator wrote
 * sort_order in that order keep a scrambled one, so every surface sorts at render time. A key the vocabulary
 * does not know goes last, in its stored order.
 */
export function orderPackSections<T extends { sectionType: string; sortOrder: number }>(sections: readonly T[]): T[] {
  const rank = (key: string): number => {
    const i = SECTIONS_META.findIndex((m) => m.key === key);
    return i === -1 ? SECTIONS_META.length : i;
  };
  return [...sections].sort((a, b) => rank(a.sectionType) - rank(b.sectionType) || a.sortOrder - b.sortOrder);
}

export const REPORT_UNAVAILABLE = 'This report could not be produced for this period.';
