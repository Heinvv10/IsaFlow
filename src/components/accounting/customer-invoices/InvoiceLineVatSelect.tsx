/**
 * A line's VAT type picker (the line grid's VAT column): the platform's fixed list for a document line
 * (DOCUMENT_LINE_VAT_TYPES: Standard, Zero-rated, Exempt), each named with its rate on the invoice date ("Standard
 * (15%)"; no percent before the date has a rate). The rate is never typed: it comes from the type (shared/vatTypes). A
 * line with no type yet (a scanned or legacy rate that is neither the standard rate nor 0) shows "Choose…".
 */
import { isRatedDate } from '@/lib/vat/standardRate';
import { Select, type SelectOption } from '@/components/ui/Select';
import { DOCUMENT_LINE_VAT_TYPES, vatTypeLabel } from '@/modules/accounting/services/shared/vatTypes';
import type { LineVatType, LineVatTypeOrNone } from './formVat';

const PLAIN: Record<LineVatType, string> = { standard: 'Standard', zero_rated: 'Zero-rated', exempt: 'Exempt' };

/** The type as the form shows it on `date` (the plain name while the date has no rate). */
export const lineVatTypeLabel = (type: LineVatType, date: string): string => (isRatedDate(date) ? vatTypeLabel(type, date) : PLAIN[type]);

export function InvoiceLineVatSelect({ value, date, onChange, disabled, label = 'VAT type' }: {
  value: LineVatTypeOrNone; date: string; onChange: (type: LineVatType) => void; disabled?: boolean;
  /** The picker's accessible name (visually hidden); a grid with several lines names each ("VAT type, line 2"). */
  label?: string;
}) {
  const options: SelectOption[] = DOCUMENT_LINE_VAT_TYPES.map((t) => ({ value: t, label: lineVatTypeLabel(t, date) }));
  return (
    <Select label={label} labelClassName="sr-only" size="sm" options={options} value={value} placeholder="Choose…" disabled={disabled}
      onChange={(v) => { if (v) onChange(v as LineVatType); }} />
  );
}
