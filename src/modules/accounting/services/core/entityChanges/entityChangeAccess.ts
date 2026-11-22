/**
 * Who may read which entity-change types, with the per-module Payroll permission added (#1656, round 7 H1).
 * mayReadType (entityChangeTypes.ts) is the role rule the entity_changes RLS policy states; a manager whose Payroll read is
 * unticked, or whose Approve is withheld (a former accountant), passes that role rule yet must not read an employee's field
 * history (name, ID number, pay, bank details), so the employee types also ask checkPermission(payroll, read).
 */
import { checkPermission } from '@/lib/auth/permissionService';
import { ENTITY_TYPES, mayReadType, type EntityType } from './entityChangeTypes';

export const PAYROLL_ENTITY_TYPES: readonly EntityType[] = ['payroll_employee', 'payroll_bank_detail'];

export const isPayrollEntityType = (type: EntityType): boolean => PAYROLL_ENTITY_TYPES.includes(type);

export async function mayReadTypeFor(companyId: string, userId: string, role: string | undefined, type: EntityType): Promise<boolean> {
  if (!mayReadType(role, type)) return false;
  return !isPayrollEntityType(type) || checkPermission(companyId, userId, 'payroll', 'read');
}

/** Every type this person may read: the role rule, and Payroll read for the employee types. */
export async function readableEntityTypes(companyId: string, userId: string, role: string | undefined): Promise<EntityType[]> {
  const payroll = await checkPermission(companyId, userId, 'payroll', 'read');
  return ENTITY_TYPES.filter((t) => mayReadType(role, t) && (payroll || !isPayrollEntityType(t)));
}
