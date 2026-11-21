/**
 * formVat.vatModeFor for the active company: 'none' for any pick when it is not registered for VAT (a registered vendor
 * outside a CompanyProvider). A function, so a mode change converts between the modes the form prices in.
 */
import { useVatRegistrationOrDefault } from '@/hooks/useVatRegistration';
import { vatModeFor } from './formVat';
import type { TaxMode } from './taxMode';

export function useVatMode(): (picked: TaxMode) => TaxMode {
  const registered = useVatRegistrationOrDefault().isRegistered;
  return (picked) => vatModeFor(registered, picked);
}
