/**
 * VAT-registration state, decided from the two company columns alone.
 *
 * Kept free of React so it can be unit-tested without a DOM — the hook in
 * useVatRegistration.ts is a thin wrapper that feeds it CompanyContext.
 *
 * `companies.vat_period = 'none'` or `vat_system_type = 'none'` is the single
 * source of truth for "not a VAT vendor" (see vatPeriodHelper).
 */
import { normalizeVatSetting, type VatSetting } from '@/modules/bureau/services/vatPeriodHelper';

export interface VatRegistration {
  /** Normalised setting; 'bi-monthly' while the company record is still loading. */
  setting: VatSetting;
  /** False only once we know the company opted out of VAT. */
  isRegistered: boolean;
  /**
   * True once the full company record (with vat_period) has loaded. Pages use
   * it to hold the "not registered" notice back until the answer is real,
   * rather than rendering VAT UI and swapping it out a tick later.
   */
  known: boolean;
}

/**
 * Pure resolver — exported so the loading-window behaviour is testable without
 * a DOM. `loading` is CompanyContext's own flag.
 */
export function resolveVatRegistration(
  vatPeriod: string | null | undefined,
  vatSystemType: string | null | undefined,
  loading: boolean,
): VatRegistration {
  // Known once either column has arrived, or once the context has finished
  // loading — a company row without VAT columns is a registered vendor on the
  // defaults, and must not leave the page waiting forever.
  const hasColumns =
    (vatPeriod != null && vatPeriod !== '') || (vatSystemType != null && vatSystemType !== '');
  const setting = hasColumns ? normalizeVatSetting(vatPeriod, vatSystemType) : 'bi-monthly';
  return { setting, isRegistered: setting !== 'none', known: hasColumns || !loading };
}

