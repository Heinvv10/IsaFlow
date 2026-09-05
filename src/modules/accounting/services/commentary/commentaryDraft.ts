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

export interface DraftSentence {
  sectionRef: string;
  rowRef: string;
  text: string;
}

const TOP_DRIVERS = 3;

export function buildDraftSentences(data: ManagementPackData): DraftSentence[] {
  const out: DraftSentence[] = [];

  // No prior period, no movement sentences. A driver against a missing
  // comparative would read as "remained flat by 0.0%", which is a claim about
  // the business that nobody measured.
  if (data.priorPeriod) {
    for (const d of identifyKeyDrivers(data.incomeStatement, data.priorPeriod).slice(0, TOP_DRIVERS)) {
      out.push({ sectionRef: 'income_statement', rowRef: d.metric, text: `${d.explanation}.` });
    }
  }

  for (const r of assessRiskAreas(data)) {
    out.push({
      sectionRef: 'balance_sheet',
      rowRef: r.area.toLowerCase().replace(/[^a-z0-9]+/g, '_'),
      text: `${r.description}.`,
    });
  }

  return out.filter(s => s.text.trim().length > 1);
}
