/**
 * A stored line explanation (payroll_run_lines.explanation, EX-core) as the ExplainDrawer shows it. Pure: it formats
 * the engine's figures for reading (money to the cent, rates as percentages) and computes nothing.
 */
import { formatMoney } from '@/lib/money/formatMoney';
import { formatDate } from '@/utils/formatters';
import type { Explanation, ExplanationLine } from '@/components/ui/ExplainDrawer';
import type { LineExplanationRead } from '@/modules/accounting/services/payroll/payrollLineExplanation';
import type { ExplainedFigure, ExplainStep, FigureExplanation } from '@/modules/accounting/services/payroll/payrollExplainTypes';

export const FIGURE_NAME: Record<ExplainedFigure, string> = { paye: 'PAYE', uif: 'UIF', sdl: 'SDL', eti: 'ETI' };

export const RECALCULATE_TO_EXPLAIN = 'Recalculate the run to see how this was calculated.';
export const PREDATES_EXPLANATIONS = 'This line was calculated before explanations were recorded; recalculate the run to see how it was calculated.';

/**
 * A line with no stored explanation. Draft: recalculating records one. Final: costed before this company's lines began
 * to carry explanations ("before <date>"), or, costed after that by code that did not record one (a rollback), the
 * date it was costed; with no recorded line at all, said without a date.
 */
export function notRecordedMessage(final: boolean, recordedFrom: string | null, costedAt: string | null = null): string {
  // A draft: say why when the line predates this company's first recorded explanation (or there is none yet).
  if (!final) return !recordedFrom || (costedAt !== null && costedAt < recordedFrom) ? PREDATES_EXPLANATIONS : RECALCULATE_TO_EXPLAIN;
  if (recordedFrom && (!costedAt || costedAt < recordedFrom)) return `Not recorded for runs costed before ${formatDate(recordedFrom)}.`;
  if (recordedFrom && costedAt) return `Not recorded: this run was costed on ${formatDate(costedAt)} by a version of IsaFlow that did not keep explanations.`;
  return 'Not recorded for runs costed before explanations were kept.';
}

function valueOf(step: ExplainStep): string {
  if (step.amount === null) return '';
  if (step.unit === 'percent') return `${Math.round(step.amount * 10_000) / 100}%`;
  if (step.unit === 'count') return String(step.amount);
  return formatMoney(step.amount);
}

function lineOf(step: ExplainStep): ExplanationLine {
  return {
    label: step.label,
    value: valueOf(step),
    ...(step.formula ? { formula: step.formula } : {}),
    ...(step.note ? { note: step.note } : {}),
    ...(step.status ? { status: step.status } : {}),
    ...(step.source ? { source: step.source } : {}),
    ...(step.children?.length ? { children: step.children.map(lineOf) } : {}),
  };
}

export function figureToExplanation(fig: FigureExplanation, who: string): Explanation {
  return {
    title: `${fig.title} for ${who}`,
    lines: fig.steps.map(lineOf),
    result: { label: fig.resultLabel, value: formatMoney(fig.result) },
    ...(fig.caution ? { caution: fig.caution } : {}),
  };
}

/** What the drawer shows for an answer from GET /api/payroll/runs/[id]/explanation. */
export function readToExplanation(read: LineExplanationRead, figure: ExplainedFigure, who: string): Explanation {
  if (read.state === 'recorded') return figureToExplanation(read.explanations[figure], who);
  return { title: `How ${FIGURE_NAME[figure]} was calculated for ${who}`, lines: [], caution: notRecordedMessage(read.final, read.recordedFrom, read.costedAt) };
}
