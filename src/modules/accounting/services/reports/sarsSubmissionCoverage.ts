/**
 * Which SARS calendar items were filed according to the company's own sars_submissions: a filed
 * status ('submitted' or 'accepted'); drafts, rejected and superseded rows never count. Only VAT201
 * and EMP201 are ever written there; EMP501 and IRP6 are manual-mark only.
 *
 * How it was filed: `filingKindOf` (sarsFilingKind.ts).
 */
import { toIsoTimestamp } from '@/lib/dateUtils';
import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import type { DbRow } from '@/types/db';
import { filingKindOf, type FilingKind } from './sarsFilingKind';

export interface FiledSubmission {
  formType: string;
  periodStart: string;
  periodEnd: string;
  reference: string | null;
  /** ISO timestamp, or null when the row has none. */
  submittedAt: string | null;
  status: string;
  channel: string | null;
  /** Display name of the user who recorded or sent it (a member of the company), or null. */
  submittedBy: string | null;
}

export type { FilingKind };

/** How a filed submission was filed (readFiledSubmissions returns filed statuses only). */
export function filingKind(s: FiledSubmission): FilingKind {
  return filingKindOf(s.status, s.channel) ?? 'recorded';
}

/** The least certain kind among several filings: processing, then recorded, then efiled. */
const KIND_RANK: Readonly<Record<FilingKind, number>> = { processing: 0, recorded: 1, efiled: 2 };
export function weakestKind(subs: FiledSubmission[]): FilingKind {
  return subs.map(filingKind).reduce((a, b) => (KIND_RANK[b] < KIND_RANK[a] ? b : a));
}

export interface FilingLine { reference: string | null; submittedAt: string | null; by: string | null }

/**
 * The filings to show, from `subs` in period order (as coveringSubmissions returns them): a row
 * identical in period and reference to an earlier one shown once.
 */
export function filingLines(subs: FiledSubmission[]): FilingLine[] {
  const seen = new Set<string>();
  const out: FilingLine[] = [];
  for (const s of subs) {
    const key = `${s.periodStart}|${s.periodEnd}|${s.reference ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ reference: s.reference, submittedAt: s.submittedAt, by: s.submittedBy });
  }
  return out;
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

/** The company's filed VAT201/EMP201 submissions overlapping [from, to]. Errors propagate (the caller holds the savepoint). */
export async function readFiledSubmissions(companyId: string, from: string, to: string): Promise<FiledSubmission[]> {
  const rows = (await sql`
    SELECT form_type, period_start, period_end, submission_reference, submitted_at, status, efiling_channel,
           public.approval_company_member_name(company_id, submitted_by::TEXT) AS submitted_by_name
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
    submittedAt: r.submitted_at ? toIsoTimestamp(r.submitted_at as Date | string) : null,
    status: String(r.status),
    channel: r.efiling_channel ? String(r.efiling_channel) : null,
    submittedBy: r.submitted_by_name ? String(r.submitted_by_name) : null,
  }));
}
