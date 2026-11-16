/**
 * Which SARS calendar items IsaFlow itself filed: the company's sars_submissions with a filed status
 * ('submitted' — on eFiling, by hand with a reference, through the return lifecycle or the ISV
 * channel while SARS processes it — or 'accepted'). Drafts, rejected and superseded rows never count.
 * Only VAT201 and EMP201 are ever written there; EMP501 and IRP6 are manual-mark only.
 */
import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import type { DbRow } from '@/types/db';

export interface FiledSubmission {
  formType: string;
  periodStart: string;
  periodEnd: string;
  reference: string | null;
  /** ISO timestamp, or null when the row has none. */
  submittedAt: string | null;
}

/** The calendar event type each submitted form completes. */
const EVENT_TYPE_OF_FORM: Readonly<Record<string, string>> = { VAT201: 'VAT201_DUE', EMP201: 'EMP201_DUE' };

const nextDay = (ymd: string): string => {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

/**
 * The filed submissions that complete the item, or null. They must be of the item's type and lie
 * wholly inside its period, and together cover every day of it (one exact-period row, or e.g. two
 * monthly VAT201s for a bi-monthly period). A submission reaching outside the period never counts:
 * a partial overlap never completes an item.
 */
export function coveringSubmissions(
  item: { eventType: string; periodStart: string; periodEnd: string },
  subs: FiledSubmission[],
): FiledSubmission[] | null {
  const inside = subs
    .filter((s) => EVENT_TYPE_OF_FORM[s.formType] === item.eventType
      && s.periodStart >= item.periodStart && s.periodEnd <= item.periodEnd && s.periodStart <= s.periodEnd)
    .sort((a, b) => a.periodStart.localeCompare(b.periodStart));
  let uncovered = item.periodStart; // the first day not yet covered
  for (const s of inside) {
    if (s.periodStart > uncovered) return null; // a gap
    if (s.periodEnd >= uncovered) uncovered = nextDay(s.periodEnd);
  }
  return uncovered > item.periodEnd ? inside : null;
}

/** The latest of the covering submissions (by submitted time; a row without one sorts first). */
export function latestSubmission(subs: FiledSubmission[]): FiledSubmission {
  return subs.reduce((a, b) => ((b.submittedAt ?? '') >= (a.submittedAt ?? '') ? b : a));
}

/** The company's filed VAT201/EMP201 submissions overlapping [from, to]. Errors propagate (the caller holds the savepoint). */
export async function readFiledSubmissions(companyId: string, from: string, to: string): Promise<FiledSubmission[]> {
  const rows = (await sql`
    SELECT form_type, period_start, period_end, submission_reference, submitted_at
    FROM sars_submissions
    WHERE company_id = ${companyId}::UUID
      AND status IN ('submitted', 'accepted')
      AND form_type IN ('VAT201', 'EMP201')
      AND period_start <= ${to}::DATE AND period_end >= ${from}::DATE
  `) as DbRow[];
  return rows.map((r) => ({
    formType: String(r.form_type),
    periodStart: fmtDate(r.period_start),
    periodEnd: fmtDate(r.period_end),
    reference: r.submission_reference ? String(r.submission_reference) : null,
    submittedAt: r.submitted_at instanceof Date ? r.submitted_at.toISOString() : r.submitted_at ? String(r.submitted_at) : null,
  }));
}
