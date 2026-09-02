export interface PracticeTimeEntry {
  id: string;
  companyId: string;
  userId: string;
  entryDate: string;
  hours: number;
  practiceClientId: string;
  jobCategoryId: string;
  workItemId: string;
  taskDescription: string;
  notes: string | null;
  billable: boolean;
  appliedRate: number | null;
  lineTotal: number | null;
  origin: 'manual' | 'assisted' | 'recurring';
  status: 'draft' | 'submitted' | 'approved' | 'billed' | 'not_billable' | 'leave' | 'invoiced';
  approvedBy: string | null;
  approvedAt: string | null;
  billedAt: string | null;
  invoiceId: string | null;
  jobId: string | null;
  writeOffReason: string | null;
  writtenOffBy: string | null;
  writtenOffAt: string | null;
  practiceClientName?: string | null;
  jobCategoryName?: string | null;
  workItemName?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PracticeTimeEntryInput {
  entryDate: string;
  hours: number;
  practiceClientId: string;
  jobCategoryId: string;
  workItemId: string;
  taskDescription: string;
  notes?: string | null;
  billable?: boolean;
  origin?: 'manual' | 'assisted' | 'recurring';
  jobId?: string | null;
}

export interface PracticeTimeEntryUpdateInput {
  entryDate?: string;
  hours?: number;
  practiceClientId?: string;
  jobCategoryId?: string;
  workItemId?: string;
  taskDescription?: string;
  notes?: string | null;
  billable?: boolean;
  jobId?: string | null;
}

export interface PracticeEntryFilters {
  userId?: string;
  practiceClientId?: string;
  dateFrom?: string;
  dateTo?: string;
  status?: PracticeTimeEntry['status'];
  jobId?: string;
  /**
   * Both optional and both omitted by default, so existing callers keep the
   * unbounded result they were written against. Postgres treats a NULL LIMIT
   * as LIMIT ALL and a NULL OFFSET as 0, which is what an absent filter binds
   * to — the MCP tools pass them because an unbounded list is not a usable
   * tool response.
   */
  limit?: number;
  offset?: number;
}

/**
 * `time_entries.hours` is NUMERIC(6,2): Postgres rounds whatever it is given to
 * two decimals. `line_total` was derived in JS from the value BEFORE that
 * rounding, so the two could disagree about the same entry —
 * `hours: 0.004` stored as `0.00` while carrying a line_total of
 * `0.004 * rate`, i.e. a zero-hour entry with a real billable amount, invisible
 * on a timesheet and real on an invoice. `hours: 1.999` stored as 2.00 while
 * billing 1.999.
 *
 * Round to the column's own scale FIRST, then derive everything from the
 * rounded value, so what is stored and what is charged always describe the same
 * entry. Callers must also range-check the ROUNDED hours: 0.004 is `> 0` before
 * rounding and `0` after, and a zero-hour entry should be refused, not stored.
 */
export const HOURS_SCALE = 2;

export function roundHours(hours: number): number {
  const factor = 10 ** HOURS_SCALE;
  return Math.round(hours * factor) / factor;
}

export function lineTotalFor(hours: number, appliedRate: number | null): number | null {
  return appliedRate == null ? null : Math.round(roundHours(hours) * appliedRate * 100) / 100;
}
