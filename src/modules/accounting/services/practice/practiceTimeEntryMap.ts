/** Row → PracticeTimeEntry. A leaf module: the time-entry service, list, workflow and WIP all import it. */
import { fmtDate } from '@/lib/fmtDate';
import type { DbRow } from '@/types/db';
import type { PracticeTimeEntry } from './practiceTimeEntryTypes';

export function mapEntry(r: DbRow): PracticeTimeEntry {
  return {
    id: String(r.id),
    companyId: String(r.company_id),
    userId: String(r.user_id),
    entryDate: fmtDate(r.entry_date),
    hours: Number(r.hours),
    practiceClientId: String(r.practice_client_id),
    jobCategoryId: String(r.job_category_id),
    workItemId: String(r.work_item_id),
    taskDescription: String(r.task_description),
    notes: r.notes ? String(r.notes) : null,
    billable: Boolean(r.billable),
    appliedRate: r.applied_rate != null ? Number(r.applied_rate) : null,
    lineTotal: r.line_total != null ? Number(r.line_total) : null,
    origin: String(r.origin) as PracticeTimeEntry['origin'],
    status: String(r.status) as PracticeTimeEntry['status'],
    approvedBy: r.approved_by ? String(r.approved_by) : null,
    approvedAt: r.approved_at ? String(r.approved_at) : null,
    billedAt: r.billed_at ? String(r.billed_at) : null,
    invoiceId: r.invoice_id ? String(r.invoice_id) : null,
    jobId: r.job_id ? String(r.job_id) : null,
    writeOffReason: r.write_off_reason ? String(r.write_off_reason) : null,
    writtenOffBy: r.written_off_by ? String(r.written_off_by) : null,
    writtenOffAt: r.written_off_at ? String(r.written_off_at) : null,
    practiceClientName: r.practice_client_name ? String(r.practice_client_name) : null,
    jobCategoryName: r.job_category_name ? String(r.job_category_name) : null,
    workItemName: r.work_item_name ? String(r.work_item_name) : null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}
