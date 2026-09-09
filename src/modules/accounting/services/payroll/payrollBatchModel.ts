import type {DbRow} from '@/lib/neon';
type Row=DbRow;
export type BatchType = 'component_values' | 'reimbursive_travel';
export type BatchStatus = 'draft' | 'validated' | 'posted' | 'cancelled';

export interface PayrollBatch {
  id: string;
  companyId: string;
  batchType: BatchType;
  componentId: string | null;
  description: string;
  periodYear: number;
  periodMonth: number;
  isRecurring: boolean;
  status: BatchStatus;
  lineCount: number;
  totalAmount: number;
  notes: string | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  postedAt: Date | null;
  postedBy: string | null;
}

export interface PayrollBatchLine {
  id: string;
  batchId: string;
  employeeId: string;
  employeeName?: string;
  employeeNumber?: string;
  value: number;
  km: number | null;
  ratePerKm: number | null;
  taxablePortion: number | null;
  nonTaxablePortion: number | null;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  notes: string | null;
  error: string | null;
  createdAt: Date;
}

export interface CreateBatchInput {
  companyId: string;
  batchType: BatchType;
  componentId?: string;
  description: string;
  periodYear: number;
  periodMonth: number;
  isRecurring?: boolean;
  notes?: string;
  userId: string;
}

export interface BatchLineInput {
  employeeId: string;
  value?: number;
  km?: number;
  ratePerKm?: number;
  taxablePortion?: number;
  nonTaxablePortion?: number;
  effectiveFrom: Date;
  effectiveTo?: Date | null;
  notes?: string;
}

export class BatchNotFoundError extends Error {
  constructor(id: string) {
    super(`Payroll batch ${id} not found`);
    this.name = 'BatchNotFoundError';
  }
}

export class BatchNotEditableError extends Error {
  readonly status: BatchStatus;
  constructor(status: BatchStatus) {
    super(`Payroll batch is ${status} — create a new batch to make changes.`);
    this.name = 'BatchNotEditableError';
    this.status = status;
  }
}

function toDate(v: unknown): Date {
  return v instanceof Date ? v : new Date(String(v));
}
function toDateOrNull(v: unknown): Date | null {
  if (v == null) return null;
  return toDate(v);
}
export function toIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function mapBatch(r: Row): PayrollBatch {
  return {
    id: String(r.id),
    companyId: String(r.company_id),
    batchType: r.batch_type as BatchType,
    componentId: r.component_id ? String(r.component_id) : null,
    description: String(r.description),
    periodYear: Number(r.period_year),
    periodMonth: Number(r.period_month),
    isRecurring: r.is_recurring === true,
    status: r.status as BatchStatus,
    lineCount: Number(r.line_count ?? 0),
    totalAmount: Number(r.total_amount ?? 0),
    notes: r.notes == null ? null : String(r.notes),
    createdBy: r.created_by == null ? null : String(r.created_by),
    createdAt: toDate(r.created_at),
    updatedAt: toDate(r.updated_at),
    postedAt: toDateOrNull(r.posted_at),
    postedBy: r.posted_by == null ? null : String(r.posted_by),
  };
}

export function mapLine(r: Row): PayrollBatchLine {
  return {
    id: String(r.id),
    batchId: String(r.batch_id),
    employeeId: String(r.employee_id),
    employeeName: r.employee_name != null ? String(r.employee_name) : undefined,
    employeeNumber: r.employee_number != null ? String(r.employee_number) : undefined,
    value: Number(r.value ?? 0),
    km: r.km == null ? null : Number(r.km),
    ratePerKm: r.rate_per_km == null ? null : Number(r.rate_per_km),
    taxablePortion: r.taxable_portion == null ? null : Number(r.taxable_portion),
    nonTaxablePortion: r.non_taxable_portion == null ? null : Number(r.non_taxable_portion),
    effectiveFrom: toDate(r.effective_from),
    effectiveTo: toDateOrNull(r.effective_to),
    notes: r.notes == null ? null : String(r.notes),
    error: r.error == null ? null : String(r.error),
    createdAt: toDate(r.created_at),
  };
}


export function assertEditable(batch: Pick<PayrollBatch, 'status'>): void {
  if (batch.status === 'posted' || batch.status === 'cancelled') {
    throw new BatchNotEditableError(batch.status);
  }
}

export function deriveLineValue(batchType: BatchType, line: BatchLineInput): number {
  if (batchType === 'reimbursive_travel') {
    if (line.value != null) return line.value;
    if (line.km != null && line.ratePerKm != null) {
      return Number((line.km * line.ratePerKm).toFixed(2));
    }
    const taxable = line.taxablePortion ?? 0;
    const nonTaxable = line.nonTaxablePortion ?? 0;
    return Number((taxable + nonTaxable).toFixed(2));
  }
  return line.value ?? 0;
}
