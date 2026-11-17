/**
 * A personal service provider's entity type on an employee's terms (wave 6 PSP, migration 999r; grill F16: its own
 * mapper, called from payrollEmployeeTerms). The entity picks the rate (SARS PAYE-GEN-01-G01-A06 row 6: 27% for a
 * company or close corporation, 45% for a trust), so a PSP needs one and nobody else may carry one, as the
 * payroll_employees_psp_entity_pair CHECK says. Judged before any write.
 */
import type { PspEntityType, TaxStatus } from './payrollTypes';

export const PSP_ENTITY_TYPES: readonly PspEntityType[] = ['company', 'trust'];
const PSP: TaxStatus = 'personal_service_provider';

type Refuse = (message: string) => Error;
const isBlank = (v: unknown) => v === undefined || v === null || v === '';

/** A body's or row's entity type: blank is none; anything else must be company or trust. */
export function pspEntityOf(value: unknown, key: string, refuse: Refuse): PspEntityType | null {
  if (isBlank(value)) return null;
  if (typeof value !== 'string' || !PSP_ENTITY_TYPES.includes(value as PspEntityType)) {
    throw refuse(`${key} must be one of: ${PSP_ENTITY_TYPES.join(', ')}`);
  }
  return value as PspEntityType;
}

/** The pair rule: a PSP is a company or a trust; nobody else has an entity type. */
export function judgePspPair(t: { taxStatus: TaxStatus; pspEntityType?: PspEntityType | null }, refuse: Refuse): void {
  if (t.taxStatus === PSP && !t.pspEntityType) throw refuse('A personal service provider must be a company or a trust (pspEntityType)');
  if (t.taxStatus !== PSP && t.pspEntityType) throw refuse('Only a personal service provider has a pspEntityType (company or trust)');
}

/** A patch's entity type: the key when present; moving off PSP with no entity in the body clears it. */
export function pspEntityOfPatch(
  body: Record<string, unknown>, taxStatus: TaxStatus | undefined, refuse: Refuse,
): { pspEntityType?: PspEntityType | null } {
  if (body.pspEntityType !== undefined) return { pspEntityType: pspEntityOf(body.pspEntityType, 'pspEntityType', refuse) };
  if (taxStatus !== undefined && taxStatus !== PSP) return { pspEntityType: null };
  return {};
}
