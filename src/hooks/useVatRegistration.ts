/**
 * VAT-registration status of the active company, for UI gating.
 *
 * `companies.vat_period = 'none'` is the single source of truth (see
 * vatPeriodHelper). CompanyContext hydrates {id, name} from localStorage
 * before the full record arrives, so `vatPeriod` is briefly undefined —
 * during that window we report `known: false` and `isRegistered: true`.
 * Failing towards "registered" keeps VAT surfaces visible for real vendors;
 * the alternative would flash VAT screens away on every page load.
 */
import { useCompany } from '@/contexts/CompanyContext';
import { normalizeVatSetting, type VatSetting } from '@/modules/bureau/services/vatPeriodHelper';

export interface VatRegistration {
  /** Normalised setting; 'bi-monthly' while the company record is still loading. */
  setting: VatSetting;
  /** False only once we know the company opted out of VAT. */
  isRegistered: boolean;
  /** True once the full company record (with vat_period) has loaded. */
  known: boolean;
}

export function useVatRegistration(): VatRegistration {
  const { activeCompany } = useCompany();
  const period = activeCompany?.vatPeriod;
  const systemType = activeCompany?.vatSystemType;
  const known = (period != null && period !== '') || (systemType != null && systemType !== '');
  const setting = known ? normalizeVatSetting(period, systemType) : 'bi-monthly';
  return { setting, isRegistered: setting !== 'none', known };
}
