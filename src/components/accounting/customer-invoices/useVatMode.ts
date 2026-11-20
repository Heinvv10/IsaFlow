/** formVat.vatModeFor for the active company: 'none' when it is not registered for VAT (a registered vendor outside a CompanyProvider). */
import { useVatRegistrationOrDefault } from '@/hooks/useVatRegistration';
import { vatModeFor } from './formVat';
import type { TaxMode } from './taxMode';

export const useVatMode = (picked: TaxMode): TaxMode => vatModeFor(useVatRegistrationOrDefault().isRegistered, picked);
