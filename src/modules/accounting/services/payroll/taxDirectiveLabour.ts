/**
 * The labour split of a SARS directive paid outside payroll (applyTaxDirective),
 * read in the lock order payrollCostCentreTags documents: the employee's
 * centres BEFORE the directive row, then the split re-read under both.
 *
 * `lockDirectiveLabour` runs first. Its directive read takes no lock: the
 * cheap refusals (not found, not approved, no employee) are answered before
 * any centre lock is waited for, and are asked again under the directive lock
 * by the caller, which is what decides. employee_id is set at creation and
 * never updated, so the centres it names are the ones to lock.
 *
 * `refreshDirectiveLabour` runs once the directive row is held, before any
 * write: allocations, own centre and mapping are read again, so an edit that
 * committed while the payment waited is what posts. If the split now names a
 * centre the first read did not lock, locking it here would take a centre
 * after a directive — the order that can close a cycle — so the payment is
 * refused with TaxDirectiveSplitChangedError (409, retryable) instead.
 * A mapping or allocation edit committed after the re-read is not seen (the
 * same window a pay-run plan has); centres cannot change under the share lock.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { readEmployeeLabourSplit, type EmployeeLabourSplit } from './payrollCostCentreTags';
import { TaxDirectiveNotApprovedError, TaxDirectiveSplitChangedError, TaxDirectiveWithoutEmployeeError } from './taxDirectiveErrors';

export async function lockDirectiveLabour(companyId: string, directiveId: string): Promise<EmployeeLabourSplit> {
  const rows = (await sql`
    SELECT status, employee_id FROM tax_directives WHERE company_id = ${companyId} AND id = ${directiveId}
  `) as DbRow[];
  const dir = rows[0];
  if (!dir) throw new Error(`Tax directive ${directiveId} not found`);
  if (String(dir.status) !== 'approved') throw new TaxDirectiveNotApprovedError(directiveId, String(dir.status));
  if (dir.employee_id == null) throw new TaxDirectiveWithoutEmployeeError(directiveId);
  return (await readEmployeeLabourSplit(companyId, String(dir.employee_id)))!;
}

export async function refreshDirectiveLabour(companyId: string, directiveId: string, first: EmployeeLabourSplit): Promise<EmployeeLabourSplit> {
  const fresh = await readEmployeeLabourSplit(companyId, first.employeeId, first.centres);
  if (!fresh) throw new TaxDirectiveSplitChangedError(directiveId);
  return fresh;
}
