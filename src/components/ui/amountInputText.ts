/** Text rules for AmountInput: pasted-text normalisation and the validity message. */

/** With `decimals` >= 3 a lone comma and exactly three digits ("1,234") is ambiguous (thousands or a 3-decimal quantity): it is returned unchanged, so the field refuses it. */
/** "R 1 234,56" -> "1234.56"; "1,234.50" -> "1234.50"; "1,234" -> "1234"; "12,5" -> "12.5". Anything else is left for the caller to refuse. */
export function normaliseAmountText(raw: string, decimals = 2): string {
  let t = raw.replace(/[Rr]/g, '').replace(/[\s  ]/g, '');
  if (t.includes(',') && t.includes('.')) {
    const decimalIsComma = t.lastIndexOf(',') > t.lastIndexOf('.');
    t = decimalIsComma ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
  } else if (t.includes(',')) {
    if (decimals >= 3 && /^\d{1,3},\d{3}$/.test(t)) return t;
    t = /^\d{1,3}(,\d{3})+$/.test(t) ? t.replace(/,/g, '') : t.replace(',', '.');
  }
  return t;
}

/** '' when the draft is acceptable, else the message for setCustomValidity. */
export function amountValidity(draft: string, o: { min?: number; max?: number; required: boolean; decimals?: number }): string {
  if (draft === '') return o.required ? 'Enter an amount.' : '';
  if (!/\d/.test(draft)) return 'Enter an amount like 100 or 100.50.';
  // Compared in units of 10^decimals (cents for money, thousandths for a quantity): 0.1 + 0.2 is not 0.3, and 0 is not 0.001.
  const unit = 10 ** (o.decimals ?? 2);
  const scaled = Math.round(Number(draft) * unit);
  if (o.min !== undefined && Number.isFinite(o.min) && scaled < Math.round(o.min * unit)) return `The amount must be at least ${o.min}.`;
  if (o.max !== undefined && Number.isFinite(o.max) && scaled > Math.round(o.max * unit)) return `The amount cannot be more than ${o.max}.`;
  return '';
}

/**
 * For a submit handler that the browser's own form check does not guard (a `noValidate` form, or a button that is not a
 * submit): true when an AmountInput under `root` (the form or modal element, never the whole document: another amount on
 * the page must not block this submit) is invalid (a refused paste, a lone ".", a value outside min/max), after
 * showing its message. A null root (not mounted) cannot happen at submit: the handler runs from the element's own
 * controls, so the ref is set; null then means nothing of ours to check. The caller aborts, so the old value is never sent silently.
 */
export function blockOnInvalidAmount(root: ParentNode | null): boolean {
  if (!root) return false; // not mounted: nothing of ours to check
  const bad = Array.from(root.querySelectorAll<HTMLInputElement>('input[data-amount-input]')).find(i => !i.validity.valid);
  if (!bad) return false;
  bad.reportValidity();
  return true;
}
