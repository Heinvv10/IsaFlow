/**
 * A contact write's payment terms as SQL parameters. `mode` is 'set' | 'days_only' | 'clear' | 'leave': an update keeps
 * the stored terms on 'leave', and the stored TYPE on 'days_only' (a bare number); a create stores NULL (not set) for
 * 'leave' and 'clear' alike. A refusal is a ContactValidationError,
 * raised before any SQL runs (the database CHECK would otherwise answer with an opaque 23514).
 */
import { PaymentTermsError, parseTermsWrite } from '../shared/paymentTerms';
import { ContactValidationError } from './contactValidationError';

export function termsColumns(input: { paymentTerms?: number | null; paymentTermsType?: string | null }) {
  try {
    const w = parseTermsWrite(input.paymentTerms, input.paymentTermsType);
    const days = w.kind === 'set' || w.kind === 'days_only' ? w.days : null;
    return {
      mode: w.kind,
      days,
      /** What an UPDATE writes as the type in mode 'set' (mode 'days_only' keeps the stored one). */
      type: w.kind === 'set' ? w.type : null,
      /** What a CREATE writes: a number alone is invoice days; nothing, or not_set, is not set. */
      createType: w.kind === 'set' ? w.type : w.kind === 'days_only' ? 'invoice_days' : null,
    };
  } catch (err) {
    if (err instanceof PaymentTermsError) throw new ContactValidationError(err.message);
    throw err;
  }
}
