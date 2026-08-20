/**
 * Pure half of the VAT-settings radio group.
 *
 * Picking a VAT system has to keep BOTH columns in step: `vat_system_type` is
 * what this control names, but `vat_period` carries the same 'none' flag and
 * is what the onboarding wizard writes. Letting them drift is the defect this
 * whole feature exists to prevent, so the decision lives in a testable
 * function rather than inline in the component.
 */
import { normalizeVatSetting } from '@/modules/bureau/services/vatPeriodHelper';

export interface VatFieldUpdate {
  field: 'vatSystemType' | 'vatPeriod';
  value: string;
}

/**
 * @param nextSystemType - 'invoice' | 'payment' | 'none', as chosen in the UI.
 * @param currentPeriod - the company's stored `vat_period`.
 */
export function vatSystemSelectionUpdates(
  nextSystemType: string,
  currentPeriod: string | null | undefined,
): VatFieldUpdate[] {
  const updates: VatFieldUpdate[] = [{ field: 'vatSystemType', value: nextSystemType }];
  if (nextSystemType === 'none') {
    // Opting out sets both columns, so no consumer can read "registered".
    updates.push({ field: 'vatPeriod', value: 'none' });
  } else if (normalizeVatSetting(currentPeriod) === 'none') {
    // Opting back in must lift the cadence off 'none' — otherwise the company
    // stays a non-vendor to every reader despite the UI saying otherwise.
    updates.push({ field: 'vatPeriod', value: 'bi-monthly' });
  }
  return updates;
}
