/**
 * Payroll Leave Service — BCEA-compliant leave management.
 * Handles leave types, balances, and requests.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';

type Row = DbRow;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface LeaveType {
  id: string;
  companyId: string;
  name: string;
  bceaType: string | null;
  accrualRule: string;
  accrualDays: number;
  maxCarryOver: number | null;
  isPaid: boolean;
  isActive: boolean;
  createdAt: string;
}

export interface LeaveBalance {
  id: string;
  companyId: string;
  employeeId: string;
  employeeName: string;
  leaveTypeId: string;
  leaveTypeName: string;
  balanceYear: number;
  accrued: number;
  taken: number;
  pending: number;
  balance: number;
}

export interface LeaveRequest {
  id: string;
  companyId: string;
  employeeId: string;
  employeeName: string;
  employeeNumber: string;
  leaveTypeId: string;
  leaveTypeName: string;
  startDate: string;
  endDate: string;
  days: number;
  reason: string | null;
  status: string;
  approvedAt: string | null;
  createdAt: string;
}

export interface CreateLeaveRequestInput {
  employeeId: string;
  leaveTypeId: string;
  startDate: string;
  endDate: string;
  days: number;
  reason?: string;
}

// ─── Mappers ─────────────────────────────────────────────────────────────────

function mapLeaveType(r: Row): LeaveType {
  return {
    id: String(r.id),
    companyId: String(r.company_id),
    name: String(r.name),
    bceaType: r.bcea_type ? String(r.bcea_type) : null,
    accrualRule: String(r.accrual_rule),
    accrualDays: Number(r.accrual_days),
    maxCarryOver: r.max_carry_over != null ? Number(r.max_carry_over) : null,
    isPaid: Boolean(r.is_paid),
    isActive: Boolean(r.is_active),
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  };
}

function mapLeaveBalance(r: Row): LeaveBalance {
  return {
    id: String(r.id),
    companyId: String(r.company_id),
    employeeId: String(r.employee_id),
    employeeName: `${r.first_name} ${r.last_name}`,
    leaveTypeId: String(r.leave_type_id),
    leaveTypeName: String(r.leave_type_name),
    balanceYear: Number(r.balance_year),
    accrued: Number(r.accrued),
    taken: Number(r.taken),
    pending: Number(r.pending),
    balance: Number(r.balance),
  };
}

function mapLeaveRequest(r: Row): LeaveRequest {
  return {
    id: String(r.id),
    companyId: String(r.company_id),
    employeeId: String(r.employee_id),
    employeeName: `${r.first_name} ${r.last_name}`,
    employeeNumber: String(r.employee_number),
    leaveTypeId: String(r.leave_type_id),
    leaveTypeName: String(r.leave_type_name),
    startDate: r.start_date instanceof Date ? r.start_date.toISOString().slice(0, 10) : String(r.start_date),
    endDate: r.end_date instanceof Date ? r.end_date.toISOString().slice(0, 10) : String(r.end_date),
    days: Number(r.days),
    reason: r.reason ? String(r.reason) : null,
    status: String(r.status),
    approvedAt: r.approved_at
      ? (r.approved_at instanceof Date ? r.approved_at.toISOString() : String(r.approved_at))
      : null,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  };
}

// ─── Leave Types ─────────────────────────────────────────────────────────────

export async function listLeaveTypes(companyId: string): Promise<LeaveType[]> {
  const rows = (await sql`
    SELECT * FROM payroll_leave_types
    WHERE company_id = ${companyId}::uuid AND is_active = TRUE
    ORDER BY name
  `) as Row[];
  return rows.map(mapLeaveType);
}

export async function createLeaveType(
  companyId: string,
  input: Omit<LeaveType, 'id' | 'companyId' | 'createdAt' | 'isActive'>,
): Promise<LeaveType> {
  const rows = (await sql`
    INSERT INTO payroll_leave_types
      (company_id, name, bcea_type, accrual_rule, accrual_days, max_carry_over, is_paid)
    VALUES (
      ${companyId}::uuid,
      ${input.name},
      ${input.bceaType ?? null},
      ${input.accrualRule},
      ${input.accrualDays},
      ${input.maxCarryOver ?? null},
      ${input.isPaid}
    )
    RETURNING *
  `) as Row[];
  if (!rows[0]) throw new Error('Insert returned no row');
  log.info('Leave type created', { companyId, name: input.name }, 'payrollLeaveService');
  return mapLeaveType(rows[0]);
}

// ─── Leave Balances ───────────────────────────────────────────────────────────

export async function listLeaveBalances(companyId: string, year: number): Promise<LeaveBalance[]> {
  const rows = (await sql`
    SELECT
      plb.*,
      pe.first_name,
      pe.last_name,
      plt.name AS leave_type_name
    FROM payroll_leave_balances plb
    JOIN payroll_employees   pe  ON pe.id  = plb.employee_id
    JOIN payroll_leave_types plt ON plt.id = plb.leave_type_id
    WHERE plb.company_id = ${companyId}::uuid
      AND plb.balance_year = ${year}
    ORDER BY pe.last_name, pe.first_name, plt.name
  `) as Row[];
  return rows.map(mapLeaveBalance);
}

// ─── Leave Requests ───────────────────────────────────────────────────────────

export async function listLeaveRequests(
  companyId: string,
  filters: { employeeId?: string; status?: string; month?: number; year?: number },
): Promise<LeaveRequest[]> {
  const rows = (await sql`
    SELECT
      plr.*,
      pe.first_name,
      pe.last_name,
      pe.employee_number,
      plt.name AS leave_type_name
    FROM payroll_leave_requests plr
    JOIN payroll_employees   pe  ON pe.id  = plr.employee_id
    JOIN payroll_leave_types plt ON plt.id = plr.leave_type_id
    WHERE plr.company_id = ${companyId}::uuid
      AND (${filters.employeeId ?? null}::uuid IS NULL OR plr.employee_id = ${filters.employeeId ?? null}::uuid)
      AND (${filters.status ?? null}::text IS NULL OR plr.status = ${filters.status ?? null})
      AND (${filters.month ?? null}::int IS NULL OR EXTRACT(MONTH FROM plr.start_date) = ${filters.month ?? null})
      AND (${filters.year ?? null}::int IS NULL OR EXTRACT(YEAR FROM plr.start_date) = ${filters.year ?? null})
    ORDER BY plr.created_at DESC
  `) as Row[];
  return rows.map(mapLeaveRequest);
}

export async function getLeaveRequest(id: string, companyId: string): Promise<LeaveRequest | null> {
  const rows = (await sql`
    SELECT
      plr.*,
      pe.first_name,
      pe.last_name,
      pe.employee_number,
      plt.name AS leave_type_name
    FROM payroll_leave_requests plr
    JOIN payroll_employees   pe  ON pe.id  = plr.employee_id
    JOIN payroll_leave_types plt ON plt.id = plr.leave_type_id
    WHERE plr.id = ${id}::uuid AND plr.company_id = ${companyId}::uuid
  `) as Row[];
  return rows.length > 0 && rows[0] ? mapLeaveRequest(rows[0]) : null;
}

export async function createLeaveRequest(
  companyId: string,
  input: CreateLeaveRequestInput,
): Promise<LeaveRequest> {
  // Verify employee belongs to company
  const empRows = (await sql`
    SELECT id FROM payroll_employees
    WHERE id = ${input.employeeId}::uuid AND company_id = ${companyId}::uuid
  `) as Row[];
  if (empRows.length === 0) throw new Error('Employee not found');

  // Verify leave type belongs to company
  const typeRows = (await sql`
    SELECT id FROM payroll_leave_types
    WHERE id = ${input.leaveTypeId}::uuid AND company_id = ${companyId}::uuid
  `) as Row[];
  if (typeRows.length === 0) throw new Error('Leave type not found');

  const rows = (await sql`
    INSERT INTO payroll_leave_requests
      (company_id, employee_id, leave_type_id, start_date, end_date, days, reason)
    VALUES (
      ${companyId}::uuid,
      ${input.employeeId}::uuid,
      ${input.leaveTypeId}::uuid,
      ${input.startDate}::date,
      ${input.endDate}::date,
      ${input.days},
      ${input.reason ?? null}
    )
    RETURNING id
  `) as Row[];
  if (!rows[0]) throw new Error('Insert returned no row');
  const created = await getLeaveRequest(String(rows[0].id), companyId);
  if (!created) throw new Error('Failed to retrieve created request');
  log.info('Leave request created', { companyId, employeeId: input.employeeId }, 'payrollLeaveService');
  return created;
}

export async function updateLeaveRequest(
  id: string,
  companyId: string,
  update: { status: 'approved' | 'rejected' | 'cancelled'; approvedBy?: string },
): Promise<LeaveRequest> {
  const now = new Date().toISOString();
  await sql`
    UPDATE payroll_leave_requests
    SET
      status      = ${update.status},
      approved_by = ${update.approvedBy ?? null}::uuid,
      approved_at = ${update.status === 'approved' ? now : null}::timestamptz
    WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid
  `;
  const updated = await getLeaveRequest(id, companyId);
  if (!updated) throw new Error('Leave request not found after update');
  log.info('Leave request updated', { id, status: update.status }, 'payrollLeaveService');
  return updated;
}

export async function deleteLeaveRequest(id: string, companyId: string): Promise<void> {
  await sql`
    DELETE FROM payroll_leave_requests
    WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid AND status = 'pending'
  `;
  log.info('Leave request deleted', { id, companyId }, 'payrollLeaveService');
}
