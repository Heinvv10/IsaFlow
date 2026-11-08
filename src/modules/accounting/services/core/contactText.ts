/** Narrow text columns on the contact write services (moved from customerWriteService; supplierWriteService shares it). */
import { ContactValidationError } from './contactValidationError';

/**
 * The trimmed value of a field whose column is NARROWER than MAX_TEXT (255), or a
 * refusal naming it. `trimmed()` slices to 255, which does nothing for a
 * VARCHAR(50): the value reached the INSERT and Postgres raised 22001, whose
 * message names the type but not the column. Refused, not sliced — a VAT or
 * bank number cut short is a wrong number, not a shorter one.
 */
export function boundedText(
  value: string | null | undefined,
  field: string,
  max: number,
): string | null {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  if (t.length > max) {
    throw new ContactValidationError(`${field} is ${t.length} characters; the maximum is ${max}`);
  }
  return t || null;
}
