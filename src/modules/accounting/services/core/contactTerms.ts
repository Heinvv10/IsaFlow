/**
 * A contact write's payment terms as SQL parameters. `mode` is 'set' | 'clear' | 'leave': an update keeps the stored
 * terms on 'leave'; a create stores NULL (not set) for 'leave' and 'clear' alike. A refusal is a ContactValidationError,
 * raised before any SQL runs (the database CHECK would otherwise answer with an opaque 23514).
 */
import { PaymentTermsError, parseTermsWrite } from '../shared/paymentTerms';
import { ContactValidationError } from './contactValidationError';

export function termsColumns(input: { paymentTerms?: number | null; paymentTermsType?: string | null }) {
  try {
    const w = parseTermsWrite(input.paymentTerms, input.paymentTermsType);
    return { mode: w.kind, days: w.kind === 'set' ? w.days : null, type: w.kind === 'set' ? w.type : null };
  } catch (err) {
    if (err instanceof PaymentTermsError) throw new ContactValidationError(err.message);
    throw err;
  }
}
