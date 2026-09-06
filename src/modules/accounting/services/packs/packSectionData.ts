/**
 * The typed reads of a `PackSection.data` blob.
 *
 * `PackSection.data` is `Record<string, unknown>` — the pack service builds a
 * different shape per section type and TypeScript cannot follow it across the
 * boundary. Four of the eight section types were therefore read by string key
 * through a `num()` / `?? []` / `?? ''` fallback, which is SILENT: rename
 * `operatingCashFlow` in `reportPackService` and the cash-flow section becomes
 * six labelled zeros — a plausible statement, on a document a director forwards
 * to a bank, with no compile error and nothing in the logs.
 *
 * The rule here is the one `packMappers.ts` already applies to the statement
 * sections: a key the section MUST have is required, and its absence throws.
 * A zero that the ledger produced is a real figure; a zero that a rename
 * produced is a lie, and the two are indistinguishable once a default has been
 * applied. Failing the render is the loud, diagnosable outcome — the same
 * ruling as `UnknownPackSectionError`.
 *
 * NOTHING HERE COMPUTES A FIGURE. Every function copies a value across.
 */
import type { KPIScorecardItem } from '@/modules/accounting/services/reports/kpiScorecardService';
import type { WaterfallStep } from '@/modules/accounting/services/reports/waterfallDataService';

/** A section whose data blob is missing a field the pack must print, or holds
 *  the wrong type in it. Thrown rather than defaulted: see this file's header. */
export class MissingPackFieldError extends Error {
  constructor(
    public readonly sectionType: string,
    public readonly field: string,
    public readonly reason: string,
  ) {
    super(`Pack section '${sectionType}' is missing field '${field}' (${reason}).`);
    this.name = 'MissingPackFieldError';
  }
}

function requireFinite(sectionType: string, d: Record<string, unknown>, field: string): number {
  const v = d[field];
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new MissingPackFieldError(sectionType, field, `expected a finite number, got ${describe(v)}`);
  }
  return v;
}

function describe(v: unknown): string {
  if (v === undefined) return 'nothing';
  if (v === null) return 'null';
  return Array.isArray(v) ? 'an array' : typeof v;
}

// ── cash_flow ────────────────────────────────────────────────────────────────

export interface PackCashFlow {
  operatingCashFlow: number;
  investingCashFlow: number;
  financingCashFlow: number;
  netCashFlow: number;
  openingCash: number;
  closingCash: number;
}

/**
 * The cash-flow lines in the order they are read, keyed by FIELD NAME rather
 * than by label. `Record<keyof PackCashFlow, string>` is what keeps the two in
 * step: adding a field to the interface without a label here is a compile
 * error, not a line that quietly disappears from the statement.
 */
const CASH_FLOW_LABELS = {
  operatingCashFlow: 'Operating Cash Flow',
  investingCashFlow: 'Investing Cash Flow',
  financingCashFlow: 'Financing Cash Flow',
  netCashFlow: 'Net Cash Flow',
  openingCash: 'Opening Cash',
  closingCash: 'Closing Cash',
} as const satisfies Record<keyof PackCashFlow, string>;

export const CASH_FLOW_FIELDS = Object.keys(CASH_FLOW_LABELS) as Array<keyof PackCashFlow>;

export function cashFlowLabel(field: keyof PackCashFlow): string {
  return CASH_FLOW_LABELS[field];
}

/** The pack's `cash_flow` section keys → a typed statement. Every one of the
 *  six is required: `reportPackService` emits all six unconditionally, so a
 *  missing one means the shape moved, not that the company had no cash. */
export function packToCashFlow(d: Record<string, unknown>): PackCashFlow {
  const out = {} as PackCashFlow;
  for (const field of CASH_FLOW_FIELDS) out[field] = requireFinite('cash_flow', d, field);
  return out;
}

// ── kpis / waterfall / commentary / ratios ───────────────────────────────────

/** The KPI scorecard. An EMPTY array is legitimate (no targets met the data);
 *  an absent one means `scorecard` was renamed. */
export function packToScorecard(d: Record<string, unknown>): KPIScorecardItem[] {
  const v = d.scorecard;
  if (!Array.isArray(v)) throw new MissingPackFieldError('kpis', 'scorecard', `expected an array, got ${describe(v)}`);
  return v as KPIScorecardItem[];
}

/** The profit-bridge steps. Empty is legitimate — the surfaces print "no
 *  profit bridge" — but absent is a rename. */
export function packToWaterfallSteps(d: Record<string, unknown>): WaterfallStep[] {
  const v = d.steps;
  if (!Array.isArray(v)) throw new MissingPackFieldError('waterfall', 'steps', `expected an array, got ${describe(v)}`);
  return v as WaterfallStep[];
}

/** The commentary prose. An empty string would print a blank page under a
 *  "Commentary" heading, which is the failure this file exists to stop. */
export function packToCommentary(d: Record<string, unknown>): string {
  const v = d.summary;
  if (typeof v !== 'string' || v.length === 0) {
    throw new MissingPackFieldError('commentary', 'summary', `expected non-empty prose, got ${describe(v)}`);
  }
  return v;
}

/** The service's own reasons for a ratio it could not compute. Always present
 *  on `ExtendedRatioResult` (possibly empty), so an absent one is a rename and
 *  would silently turn every explained null into a bare "Not meaningful". */
export function packToRatioReasons(d: Record<string, unknown>): Record<string, string> {
  const v = d.notMeaningful;
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new MissingPackFieldError('ratios', 'notMeaningful', `expected an object, got ${describe(v)}`);
  }
  return v as Record<string, string>;
}
