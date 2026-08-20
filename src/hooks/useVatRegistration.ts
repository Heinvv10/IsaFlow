/**
 * VAT-registration status of the active company, for UI gating.
 *
 * CompanyContext hydrates {id, name} from localStorage before the full record
 * arrives, so the VAT columns are briefly absent — during that window this
 * reports `known: false` and `isRegistered: true`. Failing towards
 * "registered" keeps VAT surfaces visible for real vendors; pages use `known`
 * to hold back the "not registered" notice until the answer is real.
 */
import { useCompany } from '@/contexts/CompanyContext';
import { resolveVatRegistration, type VatRegistration } from './vatRegistrationState';

export { resolveVatRegistration };
export type { VatRegistration };

export function useVatRegistration(): VatRegistration {
  const { activeCompany, loading } = useCompany();
  return resolveVatRegistration(activeCompany?.vatPeriod, activeCompany?.vatSystemType, loading);
}
