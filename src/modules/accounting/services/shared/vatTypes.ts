/**
 * The platform's VAT types: one fixed list for every company (Hein, 2026-11-19), in the ledger's
 * spelling (`VatType`, gl.types). A line names a TYPE; its rate is looked up from the type and the
 * document date, never typed by a user or sent by a caller.
 *
 * Pure: imports only the rate table, safe in a client bundle.
 */
import { standardVatRatePctOn } from '@/lib/vat/standardRate';
import type { VatType } from '../../types/gl.types';

/** Whether the type charges the standard rate, and its name on screen. */
const VAT_TYPE_INFO: Record<VatType, { label: string; rated: boolean }> = {
  standard: { label: 'Standard', rated: true },
  capital_goods: { label: 'Capital goods', rated: true },
  zero_rated: { label: 'Zero-rated', rated: false },
  export: { label: 'Zero-rated export', rated: false },
  exempt: { label: 'Exempt', rated: false },
  imported: { label: 'Imported', rated: false },
  reverse_charge: { label: 'Reverse charge', rated: false },
  bad_debt: { label: 'Bad debt', rated: false },
  no_vat: { label: 'No VAT', rated: false },
};

/**
 * The types a document line may be given today. Short on purpose: a type is added when the document's
 * posting codes its ledger lines with it, so the screen never offers a choice the VAT201 cannot report.
 */
export const DOCUMENT_LINE_VAT_TYPES = ['standard', 'zero_rated', 'exempt'] as const satisfies readonly VatType[];

/** The spellings older screens store (items and contacts: 'zero'; bank codes: 'none'). */
const LEGACY_SPELLINGS: Record<string, VatType> = { zero: 'zero_rated', none: 'no_vat' };

/** `value` as a VAT type, reading the legacy spellings; null for anything else, for the caller to refuse. */
export function normaliseVatType(value: unknown): VatType | null {
  if (typeof value !== 'string') return null;
  if (Object.hasOwn(VAT_TYPE_INFO, value)) return value as VatType;
  return Object.hasOwn(LEGACY_SPELLINGS, value) ? LEGACY_SPELLINGS[value]! : null;
}

/** The percent a line of this type carries on a document dated `date`. */
export function vatRatePctOn(vatType: VatType, date: string | Date): number {
  return VAT_TYPE_INFO[vatType].rated ? standardVatRatePctOn(date) : 0;
}

/** The type as a picker shows it: "Standard (15%)", "Zero-rated (0%)", "Exempt". */
export function vatTypeLabel(vatType: VatType, date: string | Date): string {
  const { label, rated } = VAT_TYPE_INFO[vatType];
  if (rated) return `${label} (${standardVatRatePctOn(date)}%)`;
  return vatType === 'zero_rated' || vatType === 'export' ? `${label} (0%)` : label;
}
