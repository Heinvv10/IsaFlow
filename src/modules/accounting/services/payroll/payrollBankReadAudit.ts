/**
 * A full bank account number leaving the database for a person's screen is on
 * the audit log (`export`), in the same transaction as the read, as a reveal is
 * (entityChangeReveal.ts, Hein's decision 2): the number cannot be read without
 * the record. A masked read records nothing. The record names who and whose and
 * which fields, never the values. A full GET shows every field the history masks
 * (number, branch code, holder); the duplicates list shows only the number.
 */
import { logAuditOrThrow } from '@/modules/accounting/services/core/auditTrailService';
import { SENSITIVE_FIELDS } from '@/modules/accounting/services/core/entityChanges/entityChangeMasking';
import type { RevealActor } from '@/modules/accounting/services/core/entityChanges/entityChangeReveal';
import type { EmployeeBankDetails } from './payrollBankDetailsService';
import type { DuplicateGroup } from './payrollDuplicateDetectionService';

const DETAILS_REVEALED = SENSITIVE_FIELDS.payroll_bank_detail.join(',');
const DUPLICATES_REVEALED = 'account_number';

/** One employee's active details, read in full (GET bank-details). */
export async function auditBankDetailsRead(companyId: string, actor: RevealActor, details: EmployeeBankDetails): Promise<void> {
  await logAuditOrThrow({
    companyId,
    userId: actor.userId,
    userEmail: actor.userEmail,
    action: 'export',
    entityType: 'payroll_bank_detail',
    entityId: details.id,
    changes: { fields: [], metadata: { revealed: DETAILS_REVEALED, employeeId: details.employeeId } },
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
}

/** The duplicates list, read with whole numbers: one record for the read, under the company. */
export async function auditBankDuplicatesRead(companyId: string, actor: RevealActor, groups: DuplicateGroup[]): Promise<void> {
  const employeeIds = [...new Set(groups.flatMap((g) => g.employees.map((e) => e.id)))];
  await logAuditOrThrow({
    companyId,
    userId: actor.userId,
    userEmail: actor.userEmail,
    action: 'export',
    entityType: 'payroll_bank_duplicates',
    entityId: companyId,
    changes: { fields: [], metadata: { revealed: DUPLICATES_REVEALED, groups: String(groups.length), employeeIds: employeeIds.join(',') } },
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
}
