/**
 * Garnishee orders on an employee (wave 6 GA): list, enter, end. The routes (pages/api/payroll/employees/[id]/
 * garnishee-orders*) admit payroll-detail roles (owner, admin, manager), a person's own session, never Login-as.
 *
 * Every refusal is judged before the first write (spec rule 12). Entering a company's first order creates its garnishee
 * payable account in the same transaction, under the company's role-write lock (payrollGarnisheeAccount, F13). An
 * order's facts never change once entered (the 999q trigger); a wrong order is ended and entered again. Its balance
 * moves only when a run that deducted from it is approved or reopened (payrollGarnisheeRun).
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { logAuditOrThrow } from '@/modules/accounting/services/core/auditTrailService';
import { ensureGarnisheePayable } from './payrollGarnisheeAccount';
import { GARNISHEE_KINDS, GarnisheeOrderRefusal, type GarnisheeKind } from './payrollGarnishee';

export { GarnisheeOrderRefusal };

export interface GarnisheeActor {
  userId: string;
  userEmail?: string;
  ip?: string;
  userAgent?: string;
  sessionId?: string | null;
}

export interface GarnisheeOrderInputFields {
  kind: GarnisheeKind;
  reference: string;
  creditorName: string;
  instalment: number;
  totalDebt: number | null;
  startDate: string;
  endDate: string | null;
  priority: number;
}

export interface GarnisheeOrder extends GarnisheeOrderInputFields {
  id: string;
  employeeId: string;
  balance: number | null;
  status: 'active' | 'ended' | 'satisfied';
  endReason: string | null;
  payableAccountId: string;
  createdAt: string;
  /** What runs have deducted for it, and how much of that their approvals applied to the balance. */
  deducted: number;
  applied: number;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const isRealDate = (s: string) => ISO_DATE.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const isCents = (n: number) => Number.isFinite(n) && Math.abs(Math.round(n * 100) - n * 100) < 1e-6;

/** The fields as stored (trimmed), or a 400 refusal naming the first problem. Pure. */
export function judgeGarnisheeOrder(f: GarnisheeOrderInputFields): GarnisheeOrderInputFields {
  const bad = (message: string): never => { throw new GarnisheeOrderRefusal(400, 'INVALID_ORDER', message); };
  if (!(GARNISHEE_KINDS as readonly string[]).includes(f.kind)) bad(`kind must be one of ${GARNISHEE_KINDS.join(', ')}.`);
  const reference = f.reference.trim();
  const creditorName = f.creditorName.trim();
  if (reference.length < 1 || reference.length > 100) bad('The court or case reference is required (at most 100 characters).');
  if (creditorName.length < 1 || creditorName.length > 200) bad('The creditor is required (at most 200 characters).');
  if (!(f.instalment > 0) || !isCents(f.instalment) || f.instalment >= 1e12) bad('The instalment must be more than R0.00, in cents.');
  if (f.totalDebt !== null && (!(f.totalDebt > 0) || !isCents(f.totalDebt) || f.totalDebt >= 1e12)) bad('The total debt, when given, must be more than R0.00, in cents.');
  if (!isRealDate(f.startDate)) bad('The start date must be a real date, YYYY-MM-DD.');
  if (f.endDate !== null && (!isRealDate(f.endDate) || f.endDate < f.startDate)) bad('The end date must be a real date on or after the start date.');
  if (!Number.isInteger(f.priority) || f.priority < 1 || f.priority > 9999) bad('The priority must be a whole number from 1 to 9999 (1 is taken first).');
  return { ...f, reference, creditorName };
}

const num = (v: unknown): number | null => (v == null ? null : Number(v));
const day = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

function mapOrder(r: DbRow): GarnisheeOrder {
  return {
    id: String(r.id), employeeId: String(r.employee_id), kind: r.kind as GarnisheeKind, reference: String(r.reference),
    creditorName: String(r.creditor_name), instalment: Number(r.instalment), totalDebt: num(r.total_debt), balance: num(r.balance),
    startDate: day(r.start_date)!, endDate: day(r.end_date), priority: Number(r.priority), status: r.status as GarnisheeOrder['status'],
    endReason: r.end_reason == null ? null : String(r.end_reason), payableAccountId: String(r.payable_account_id),
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    deducted: Number(r.deducted ?? 0), applied: Number(r.applied ?? 0),
  };
}

async function employeeIsThisCompanys(companyId: string, employeeId: string): Promise<boolean> {
  const rows = (await sql`
    SELECT 1 FROM payroll_employees WHERE id = ${employeeId}::uuid AND company_id = ${companyId}::uuid
  `) as DbRow[];
  return rows.length > 0;
}

/** The employee's orders, newest first; null when the employee is not this company's. */
export async function listGarnisheeOrders(companyId: string, employeeId: string): Promise<GarnisheeOrder[] | null> {
  if (!(await employeeIsThisCompanys(companyId, employeeId))) return null;
  const rows = (await sql`
    SELECT o.*,
           COALESCE((SELECT sum(d.amount) FROM payroll_garnishee_deductions d WHERE d.order_id = o.id AND d.company_id = o.company_id), 0) AS deducted,
           COALESCE((SELECT sum(d.amount) FROM payroll_garnishee_deductions d
                      WHERE d.order_id = o.id AND d.company_id = o.company_id AND d.balance_applied), 0) AS applied
      FROM payroll_garnishee_orders o
     WHERE o.company_id = ${companyId}::uuid AND o.employee_id = ${employeeId}::uuid
     ORDER BY o.created_at DESC, o.id
  `) as DbRow[];
  return rows.map(mapOrder);
}

export async function createGarnisheeOrder(
  companyId: string, employeeId: string, fields: GarnisheeOrderInputFields, actor: GarnisheeActor,
): Promise<GarnisheeOrder> {
  const f = judgeGarnisheeOrder(fields);
  if (!(await employeeIsThisCompanys(companyId, employeeId))) {
    throw new GarnisheeOrderRefusal(404, 'EMPLOYEE_NOT_FOUND', 'Employee not found.');
  }
  // First write: the payable (created only for the company's first order), then the order, in one transaction.
  const payable = await ensureGarnisheePayable(companyId);
  const rows = (await sql`
    INSERT INTO payroll_garnishee_orders (
      company_id, employee_id, kind, reference, creditor_name, instalment, total_debt, balance, start_date, end_date, priority,
      payable_account_id, created_by
    ) VALUES (
      ${companyId}::uuid, ${employeeId}::uuid, ${f.kind}, ${f.reference}, ${f.creditorName}, ${f.instalment}, ${f.totalDebt},
      ${f.totalDebt}, ${f.startDate}::date, ${f.endDate}::date, ${f.priority}, ${payable.id}::uuid, ${actor.userId}
    )
    RETURNING *
  `) as DbRow[];
  const order = mapOrder(rows[0]!);
  await logAuditOrThrow({
    companyId, userId: actor.userId, userEmail: actor.userEmail, action: 'create', entityType: 'payroll_garnishee_order',
    entityId: order.id, entityRef: order.reference,
    changes: { fields: [
      { field: 'kind', old: null, new: order.kind, label: 'Kind' },
      { field: 'instalment', old: null, new: order.instalment.toFixed(2), label: 'Instalment' },
      { field: 'total_debt', old: null, new: order.totalDebt == null ? null : order.totalDebt.toFixed(2), label: 'Total debt' },
      ...(payable.created ? [{ field: 'payable_account_id', old: null, new: payable.id, label: 'Garnishee payable account created' }] : []),
    ] },
    ip: actor.ip, userAgent: actor.userAgent, sessionId: actor.sessionId ?? undefined,
  });
  return order;
}

/**
 * End an order from `endDate` on (runs whose period starts after it no longer deduct). A run that already deducted
 * keeps its deduction. Refused for another company's order (404) or one already ended (409).
 */
export async function endGarnisheeOrder(
  companyId: string, employeeId: string, orderId: string, input: { endDate: string; reason: string }, actor: GarnisheeActor,
): Promise<GarnisheeOrder> {
  const reason = input.reason.trim();
  if (reason.length < 5 || reason.length > 500) throw new GarnisheeOrderRefusal(400, 'INVALID_REASON', 'Say why the order ends (5 to 500 characters).');
  if (!isRealDate(input.endDate)) throw new GarnisheeOrderRefusal(400, 'INVALID_ORDER', 'The end date must be a real date, YYYY-MM-DD.');
  const found = (await sql`
    SELECT status, start_date FROM payroll_garnishee_orders
     WHERE id = ${orderId}::uuid AND company_id = ${companyId}::uuid AND employee_id = ${employeeId}::uuid
     FOR UPDATE
  `) as DbRow[];
  const row = found[0];
  if (!row) throw new GarnisheeOrderRefusal(404, 'ORDER_NOT_FOUND', 'Garnishee order not found.');
  if (row.status === 'ended') throw new GarnisheeOrderRefusal(409, 'ORDER_ENDED', 'This order has already ended.');
  if (input.endDate < day(row.start_date)!) throw new GarnisheeOrderRefusal(400, 'INVALID_ORDER', 'The end date must be on or after the start date.');
  await sql`
    UPDATE payroll_garnishee_orders
       SET status = 'ended', end_date = ${input.endDate}::date, end_reason = ${reason}, ended_by = ${actor.userId}, ended_at = now()
     WHERE id = ${orderId}::uuid AND company_id = ${companyId}::uuid
  `;
  await logAuditOrThrow({
    companyId, userId: actor.userId, userEmail: actor.userEmail, action: 'update', entityType: 'payroll_garnishee_order',
    entityId: orderId, changes: { fields: [{ field: 'status', old: String(row.status), new: 'ended', label: `Ended: ${reason}` }] },
    ip: actor.ip, userAgent: actor.userAgent, sessionId: actor.sessionId ?? undefined,
  });
  return (await listGarnisheeOrders(companyId, employeeId))!.find((o) => o.id === orderId)!;
}
