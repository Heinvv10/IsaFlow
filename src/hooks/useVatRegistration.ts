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

/**
 * As useVatRegistration, but outside a CompanyProvider it reports a registered vendor (known) instead of throwing, so a
 * form rendered without one keeps charging VAT. Any other error is re-thrown.
 */
export function useVatRegistrationOrDefault(): VatRegistration {
  let company: ReturnType<typeof useCompany> | null;
  try {
    // useCompany calls useContext first on every render and only then throws, so the hook order never changes. Read the
    // context through useCompany, not CompanyContext directly: page tests mock the module with useCompany alone.
    // eslint-disable-next-line react-hooks/rules-of-hooks
    company = useCompany();
  } catch (err) {
    if (!(err instanceof Error && err.message.includes('within a CompanyProvider'))) throw err;
    company = null;
  }
  return resolveVatRegistration(company?.activeCompany?.vatPeriod, company?.activeCompany?.vatSystemType, company?.loading ?? false);
}
