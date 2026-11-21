import type { ReturnForm } from './returnVersionTypes';

/** The URL segment (`vat201` | `emp201`) as a form, or null. */
export function returnFormOf(segment: string | string[] | undefined): ReturnForm | null {
  if (segment === 'vat201') return 'VAT201';
  if (segment === 'emp201') return 'EMP201';
  return null;
}

/**
 * The module whose Approve finalising, filing or marking a return submitted takes (#1656, Hein: gate everything; filing ruled in
 * 2026-11-21): VAT201 is VAT & Tax, EMP201 / EMP501 / IRP5 are Payroll. null for any other form: refused, whoever asks.
 */
export function returnApproveModule(form: string): 'vat' | 'payroll' | null {
  if (form === 'VAT201') return 'vat';
  if (form === 'EMP201' || form === 'EMP501' || form === 'IRP5') return 'payroll';
  return null;
}
