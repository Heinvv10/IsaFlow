/** formVat.vatModeFor for the active company: 'none' when it is not registered for VAT (a registered vendor outside a CompanyProvider). */
import { useVatRegistrationOrDefault } from '@/hooks/useVatRegistration';
import { vatModeFor } from './formVat';
import type { TaxMode } from './taxMode';

export const useVatMode = (picked: TaxMode): TaxMode => vatModeFor(useVatRegistrationOrDefault().isRegistered, picked);

/** The mode the form prices in and whether the company is registered (taxModeSwitch decides what a switch may do). */
export function useVatChoice(picked: TaxMode): { vatMode: TaxMode; registered: boolean } {
  const registered = useVatRegistrationOrDefault().isRegistered;
  return { vatMode: vatModeFor(registered, picked), registered };
}

export { switchTaxMode, taxModesFor } from './taxModeSwitch';
