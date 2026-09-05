/**
 * Turns the existing pure analysers in aiCommentaryService into placed
 * sentences: a sectionRef (which pack section the sentence sits under) and a
 * rowRef (which figure it explains), so the UI can print it directly beneath
 * that figure rather than in a side panel.
 *
 * This produces DRAFTS ONLY. Nothing here writes approved_text, and nothing
 * here reaches a share link until a person approves it in commentaryService.
 */
import {
  identifyKeyDrivers, assessRiskAreas, type ManagementPackData,
} from '@/modules/accounting/services/reports/aiCommentaryService';
import { equityBasisFailure } from '@/modules/accounting/services/reports/ratioBasis';

export interface DraftSentence {
  sectionRef: string;
  rowRef: string;
  text: string;
}

/**
 * `ManagementPackData` with the one figure that can legitimately not exist.
 *
 * `calculateExtendedRatios` returns null for debt-to-equity exactly when equity
 * is zero or negative, which is the worst leverage case there is. Coercing that
 * to 0 upstream would make `assessRiskAreas`'s `> 2.0` branch false and the
 * pack would say nothing about gearing for the one company that most needs it
 * said. The null travels this far so the sentence below can be emitted instead.
 *
 * A plain `ManagementPackData` still satisfies this type — `number` is
 * assignable to `number | null`.
 */
export interface CommentaryPackData extends Omit<ManagementPackData, 'balanceSheet'> {
  balanceSheet: Omit<ManagementPackData['balanceSheet'], 'debtEquityRatio'> & {
    /** null when the ratio has no arithmetic meaning. Never 0 standing in for null. */
    debtEquityRatio: number | null;
    /** Why it is null, in the reporting engine's own words (`equityNotMeaningful`). */
    debtEquityUnavailableReason?: string;
  };
}

const TOP_DRIVERS = 3;

export function buildDraftSentences(data: CommentaryPackData): DraftSentence[] {
  const out: DraftSentence[] = [];

  // No prior period, no movement sentences. A driver against a missing
  // comparative would read as "remained flat by 0.0%", which is a claim about
  // the business that nobody measured.
  if (data.priorPeriod) {
    for (const d of identifyKeyDrivers(data.incomeStatement, data.priorPeriod).slice(0, TOP_DRIVERS)) {
      out.push({ sectionRef: 'income_statement', rowRef: d.metric, text: `${d.explanation}.` });
    }
  }

  const ratio = data.balanceSheet.debtEquityRatio;
  // assessRiskAreas takes a number. Where the ratio does not exist we hand it
  // 0, which SILENCES its leverage branch rather than asserting anything; the
  // disclosure that branch would have made is supplied explicitly below. The 0
  // never reaches a sentence.
  const analysable: ManagementPackData = {
    ...data,
    balanceSheet: { ...data.balanceSheet, debtEquityRatio: ratio ?? 0 },
  };

  for (const r of assessRiskAreas(analysable)) {
    out.push({
      sectionRef: 'balance_sheet',
      rowRef: r.area.toLowerCase().replace(/[^a-z0-9]+/g, '_'),
      text: `${r.description}.`,
    });
  }

  if (ratio === null) {
    out.push({
      sectionRef: 'balance_sheet',
      rowRef: 'equity',
      text:
        data.balanceSheet.debtEquityUnavailableReason
        ?? equityBasisFailure(data.balanceSheet.equity)
        ?? 'Debt-to-equity is not meaningful for this balance sheet.',
    });
  }

  return out.filter(s => s.text.trim().length > 1);
}
