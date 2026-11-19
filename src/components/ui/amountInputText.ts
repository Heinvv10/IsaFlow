/** Text rules for AmountInput: pasted-text normalisation and the validity message. */

/** "R 1 234,56" -> "1234.56"; "1,234.50" -> "1234.50"; "1,234" -> "1234"; "12,5" -> "12.5". Anything else is left for the caller to refuse. */
export function normaliseAmountText(raw: string): string {
  let t = raw.replace(/[Rr]/g, '').replace(/[\s  ]/g, '');
  if (t.includes(',') && t.includes('.')) {
    const decimalIsComma = t.lastIndexOf(',') > t.lastIndexOf('.');
    t = decimalIsComma ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
  } else if (t.includes(',')) {
    t = /^\d{1,3}(,\d{3})+$/.test(t) ? t.replace(/,/g, '') : t.replace(',', '.');
  }
  return t;
}

/** '' when the draft is acceptable, else the message for setCustomValidity. */
export function amountValidity(draft: string, o: { min?: number; max?: number; required: boolean }): string {
  if (draft === '') return o.required ? 'Enter an amount.' : '';
  if (!/\d/.test(draft)) return 'Enter an amount like 100 or 100.50.';
  const n = Number(draft);
  if (o.min !== undefined && n < o.min) return `The amount must be at least ${o.min}.`;
  if (o.max !== undefined && n > o.max) return `The amount cannot be more than ${o.max}.`;
  return '';
}
