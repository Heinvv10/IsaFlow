/**
 * Pay scale (salary grade) master + employee assignment (mig 453).
 *
 * The (min, mid, max) band is advisory — assigning an employee whose
 * actual salary is outside the band does not fail; the UI flags it so
 * comp-review can act. min <= mid <= max is enforced both at the DB
 * CHECK and here (so updates that provide only part of the triplet
 * validate against the stored values).
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { recordEmployeeChange } from './payrollEmployeeHistoryService';

export interface PayScale {
  id: string;
  companyId: string;
  code: string;
  name: string;
  gradeLevel: number;
  minSalary: number;
  midSalary: number;
  maxSalary: number;
  currency: string;
  isActive: boolean;
  notes: string | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export class PayScaleNotFoundError extends Error {
  constructor(id: string) {
    super(`Pay scale ${id} not found`);
    this.name = 'PayScaleNotFoundError';
  }
}

export class InvalidSalaryBandError extends Error {
  constructor(reason: string) {
    super(`Invalid salary band: ${reason}`);
    this.name = 'InvalidSalaryBandError';
  }
}

function toDate(v: unknown): Date {
  return v instanceof Date ? v : new Date(String(v));
}

function mapPayScale(r: DbRow): PayScale {
  return {
    id: String(r.id),
    companyId: String(r.company_id),
    code: String(r.code),
    name: String(r.name),
    gradeLevel: Number(r.grade_level) || 0,
    minSalary: Number(r.min_salary),
    midSalary: Number(r.mid_salary),
    maxSalary: Number(r.max_salary),
    currency: String(r.currency),
    isActive: r.is_active === true,
    notes: r.notes == null ? null : String(r.notes),
    createdBy: r.created_by == null ? null : String(r.created_by),
    createdAt: toDate(r.created_at),
    updatedAt: toDate(r.updated_at),
  };
}

function validateBand(min: number, mid: number, max: number): void {
  if (min > mid) throw new InvalidSalaryBandError(`min (${min}) > mid (${mid})`);
  if (mid > max) throw new InvalidSalaryBandError(`mid (${mid}) > max (${max})`);
}

export interface CreatePayScaleInput {
  companyId: string;
  code: string;
  name: string;
  gradeLevel: number;
  minSalary: number;
  midSalary: number;
  maxSalary: number;
  currency?: string;
  notes?: string;
  userId: string;
}

export async function createPayScale(input: CreatePayScaleInput): Promise<PayScale> {
  validateBand(input.minSalary, input.midSalary, input.maxSalary);
  const code = input.code.trim();
  const name = input.name.trim();
  if (!code) throw new Error('code is required');
  if (!name) throw new Error('name is required');
  log.info('Creating pay scale', { companyId: input.companyId, code }, 'payScaleService');

  const rows = (await sql`
    INSERT INTO pay_scales
      (company_id, code, name, grade_level, min_salary, mid_salary, max_salary, currency, notes, created_by)
    VALUES (
      ${input.companyId}::uuid, ${code}, ${name}, ${input.gradeLevel},
      ${input.minSalary}, ${input.midSalary}, ${input.maxSalary},
      ${input.currency ?? 'ZAR'}, ${input.notes ?? null}, ${input.userId}
    )
    RETURNING *
  `) as DbRow[];
  if (!rows[0]) throw new Error('INSERT returned no row');
  return mapPayScale(rows[0]);
}

export async function listPayScales(
  companyId: string,
  opts: { activeOnly?: boolean } = {},
): Promise<PayScale[]> {
  const rows = (await sql`
    SELECT * FROM pay_scales
     WHERE company_id = ${companyId}::uuid
       AND (${opts.activeOnly === true ? true : false}::boolean = false OR is_active = true)
     ORDER BY grade_level, code
  `) as DbRow[];
  return rows.map(mapPayScale);
}

async function assertPayScaleInCompany(companyId: string, id: string): Promise<DbRow> {
  const rows = (await sql`
    SELECT * FROM pay_scales
     WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid
     LIMIT 1
  `) as DbRow[];
  if (rows.length === 0 || !rows[0]) throw new PayScaleNotFoundError(id);
  return rows[0];
}

async function assertEmployeeInCompany(companyId: string, employeeId: string): Promise<DbRow> {
  const rows = (await sql`
    SELECT id, pay_scale_id FROM payroll_employees
     WHERE id = ${employeeId}::uuid AND company_id = ${companyId}::uuid
     LIMIT 1
  `) as DbRow[];
  if (rows.length === 0 || !rows[0]) throw new Error(`Employee ${employeeId} not in company`);
  return rows[0];
}

export interface UpdatePayScaleInput {
  code?: string;
  name?: string;
  gradeLevel?: number;
  minSalary?: number;
  midSalary?: number;
  maxSalary?: number;
  currency?: string;
  notes?: string | null;
  isActive?: boolean;
}

export async function updatePayScale(
  companyId: string,
  id: string,
  input: UpdatePayScaleInput,
): Promise<void> {
  const current = await assertPayScaleInCompany(companyId, id);
  const nextMin = input.minSalary ?? Number(current.min_salary);
  const nextMid = input.midSalary ?? Number(current.mid_salary);
  const nextMax = input.maxSalary ?? Number(current.max_salary);
  validateBand(nextMin, nextMid, nextMax);

  await sql`
    UPDATE pay_scales SET
      code        = COALESCE(${input.code ?? null}, code),
      name        = COALESCE(${input.name ?? null}, name),
      grade_level = COALESCE(${input.gradeLevel ?? null}::int, grade_level),
      min_salary  = COALESCE(${input.minSalary ?? null}::numeric, min_salary),
      mid_salary  = COALESCE(${input.midSalary ?? null}::numeric, mid_salary),
      max_salary  = COALESCE(${input.maxSalary ?? null}::numeric, max_salary),
      currency    = COALESCE(${input.currency ?? null}, currency),
      notes       = COALESCE(${input.notes ?? null}, notes),
      is_active   = COALESCE(${input.isActive ?? null}::boolean, is_active),
      updated_at  = NOW()
    WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid
  `;
}

export async function assignEmployeePayScale(
  companyId: string,
  employeeId: string,
  payScaleId: string | null,
  userId?: string,
): Promise<void> {
  const emp = await assertEmployeeInCompany(companyId, employeeId);
  if (payScaleId !== null) await assertPayScaleInCompany(companyId, payScaleId);

  const oldValue = emp.pay_scale_id == null ? null : String(emp.pay_scale_id);

  await sql`
    UPDATE payroll_employees
       SET pay_scale_id = ${payScaleId}::uuid,
           updated_at = NOW()
     WHERE id = ${employeeId}::uuid AND company_id = ${companyId}::uuid
  `;

  if (userId) {
    await recordEmployeeChange({
      companyId,
      employeeId,
      fieldName: 'pay_scale_id',
      oldValue,
      newValue: payScaleId,
      userId,
    });
  }
}
