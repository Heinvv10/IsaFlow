/**
 * Pay package master + application to employees (mig 454).
 *
 * Applying a package:
 *   1. End-date any OPEN assignment (effective_to IS NULL) for each of the
 *      package's components, set effective_to = effectiveFrom - 1 day.
 *   2. Insert a new payroll_employee_components row per package row with
 *      the package's default amount + is_recurring flag.
 *
 * The whole apply runs in a single transaction so partial application is
 * impossible. Subsequent edits to the package do not retroactively change
 * already-materialised assignments — a new "apply" is required.
 */

import { sql, withTransaction } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';

export interface PayPackage {
  id: string;
  companyId: string;
  code: string;
  name: string;
  description: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface PayPackageComponent {
  id: string;
  componentId: string;
  componentName: string;
  sarsSourceCode: string;
  componentType: string;
  amount: number;
  isRecurring: boolean;
}

export interface PayPackageWithComponents extends PayPackage {
  components: PayPackageComponent[];
}

export class PayPackageNotFoundError extends Error {
  constructor(id: string) {
    super(`Pay package ${id} not found`);
    this.name = 'PayPackageNotFoundError';
  }
}

function toDate(v: unknown): Date {
  return v instanceof Date ? v : new Date(String(v));
}

function mapPackage(r: DbRow): PayPackage {
  return {
    id: String(r.id),
    companyId: String(r.company_id),
    code: String(r.code),
    name: String(r.name),
    description: r.description == null ? null : String(r.description),
    isActive: r.is_active === true,
    createdAt: toDate(r.created_at),
    updatedAt: toDate(r.updated_at),
  };
}

async function assertPackageInCompany(companyId: string, id: string): Promise<void> {
  const rows = (await sql`
    SELECT id FROM pay_packages
     WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid
     LIMIT 1
  `) as DbRow[];
  if (rows.length === 0) throw new PayPackageNotFoundError(id);
}

async function assertEmployeeInCompany(companyId: string, employeeId: string): Promise<void> {
  const rows = (await sql`
    SELECT id FROM payroll_employees
     WHERE id = ${employeeId}::uuid AND company_id = ${companyId}::uuid
     LIMIT 1
  `) as DbRow[];
  if (rows.length === 0) throw new Error(`Employee ${employeeId} not in company`);
}

export interface CreatePayPackageInput {
  companyId: string;
  code: string;
  name: string;
  description?: string;
  userId: string;
}

export async function createPayPackage(input: CreatePayPackageInput): Promise<PayPackage> {
  const code = input.code.trim();
  const name = input.name.trim();
  if (!code) throw new Error('code is required');
  if (!name) throw new Error('name is required');

  log.info('Creating pay package', { companyId: input.companyId, code }, 'payPackageService');

  const rows = (await sql`
    INSERT INTO pay_packages (company_id, code, name, description, created_by)
    VALUES (${input.companyId}::uuid, ${code}, ${name}, ${input.description ?? null}, ${input.userId})
    RETURNING *
  `) as DbRow[];
  if (!rows[0]) throw new Error('INSERT returned no row');
  return mapPackage(rows[0]);
}

export async function listPayPackages(
  companyId: string,
  opts: { activeOnly?: boolean } = {},
): Promise<PayPackage[]> {
  const rows = (await sql`
    SELECT * FROM pay_packages
     WHERE company_id = ${companyId}::uuid
       AND (${opts.activeOnly === true ? true : false}::boolean = false OR is_active = true)
     ORDER BY code
  `) as DbRow[];
  return rows.map(mapPackage);
}

export async function getPayPackage(
  companyId: string,
  id: string,
): Promise<PayPackageWithComponents | null> {
  const pkgRows = (await sql`
    SELECT * FROM pay_packages
     WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid
     LIMIT 1
  `) as DbRow[];
  if (pkgRows.length === 0 || !pkgRows[0]) return null;

  const compRows = (await sql`
    SELECT pc.id, pc.component_id, pc.amount, pc.is_recurring,
           c.name AS component_name, c.sars_source_code, c.component_type
      FROM pay_package_components pc
      JOIN payroll_components c ON c.id = pc.component_id
     WHERE pc.package_id = ${id}::uuid
     ORDER BY c.name
  `) as DbRow[];

  return {
    ...mapPackage(pkgRows[0]),
    components: compRows.map(r => ({
      id: String(r.id),
      componentId: String(r.component_id),
      componentName: String(r.component_name),
      sarsSourceCode: String(r.sars_source_code),
      componentType: String(r.component_type),
      amount: Number(r.amount),
      isRecurring: r.is_recurring === true,
    })),
  };
}

export interface PackageComponentInput {
  componentId: string;
  amount: number;
  isRecurring: boolean;
}

export async function setPackageComponents(
  companyId: string,
  packageId: string,
  components: PackageComponentInput[],
): Promise<void> {
  await assertPackageInCompany(companyId, packageId);

  if (components.length > 0) {
    const componentIds = components.map(c => c.componentId);
    const rows = (await sql`
      SELECT id FROM payroll_components
       WHERE company_id = ${companyId}::uuid
         AND id = ANY(${componentIds}::uuid[])
    `) as DbRow[];
    if (rows.length !== componentIds.length) {
      throw new Error('One or more components not in company');
    }
  }

  // withTransaction, NEVER raw BEGIN/COMMIT. A raw `sql`COMMIT`` routes onto
  // the ALS request client (`neon.ts` LazyQuery.run), which is the transaction
  // `withAuth` opens for every request — so it commits the WHOLE request, makes
  // every earlier write durable and destroys any enclosing savepoint.
  // `withTransaction` nests a SAVEPOINT when a request transaction is in flight
  // and opens a real one only when there is none.
  await withTransaction(async (tx) => {
    await tx`DELETE FROM pay_package_components WHERE package_id = ${packageId}::uuid`;
    for (const c of components) {
      await tx`
        INSERT INTO pay_package_components (package_id, component_id, amount, is_recurring)
        VALUES (${packageId}::uuid, ${c.componentId}::uuid, ${c.amount}, ${c.isRecurring})
      `;
    }
  });
}

export interface UpdatePayPackageInput {
  code?: string;
  name?: string;
  description?: string | null;
  isActive?: boolean;
}

export async function updatePayPackage(
  companyId: string,
  id: string,
  input: UpdatePayPackageInput,
): Promise<void> {
  await assertPackageInCompany(companyId, id);
  await sql`
    UPDATE pay_packages SET
      code        = COALESCE(${input.code ?? null}, code),
      name        = COALESCE(${input.name ?? null}, name),
      description = COALESCE(${input.description ?? null}, description),
      is_active   = COALESCE(${input.isActive ?? null}::boolean, is_active),
      updated_at  = NOW()
    WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid
  `;
}

export interface ApplyResult {
  inserted: number;
  ended: number;
}

export async function applyPackageToEmployee(
  companyId: string,
  packageId: string,
  employeeId: string,
  effectiveFrom: string,
  userId: string,
): Promise<ApplyResult> {
  await assertEmployeeInCompany(companyId, employeeId);
  await assertPackageInCompany(companyId, packageId);

  const compRows = (await sql`
    SELECT component_id, amount, is_recurring
      FROM pay_package_components
     WHERE package_id = ${packageId}::uuid
  `) as DbRow[];
  if (compRows.length === 0) return { inserted: 0, ended: 0 };

  log.info(
    'Applying pay package',
    { companyId, packageId, employeeId, effectiveFrom, userId, rowCount: compRows.length },
    'payPackageService',
  );

  // withTransaction, NEVER raw BEGIN/COMMIT. A raw `sql`COMMIT`` routes onto
  // the ALS request client (`neon.ts` LazyQuery.run), which is the transaction
  // `withAuth` opens for every request — so it commits the WHOLE request, makes
  // every earlier write durable and destroys any enclosing savepoint.
  // `withTransaction` nests a SAVEPOINT when a request transaction is in flight
  // and opens a real one only when there is none.
  return withTransaction(async (tx) => {
    let ended = 0;
    for (const r of compRows) {
      const componentId = String(r.component_id);
      const endResult = (await tx`
        UPDATE payroll_employee_components
           SET effective_to = (${effectiveFrom}::date - INTERVAL '1 day')::date
         WHERE employee_id = ${employeeId}::uuid
           AND component_id = ${componentId}::uuid
           AND effective_to IS NULL
        RETURNING id
      `) as DbRow[];
      ended += endResult.length;

      await tx`
        INSERT INTO payroll_employee_components
          (employee_id, component_id, amount, effective_from, is_recurring)
        VALUES
          (${employeeId}::uuid, ${componentId}::uuid, ${Number(r.amount)}, ${effectiveFrom}::date, ${r.is_recurring === true})
      `;
    }
    return { inserted: compRows.length, ended };
  });
}
