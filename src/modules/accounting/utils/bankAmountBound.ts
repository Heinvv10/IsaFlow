/**
 * The list's Min/Max amount bounds compare ABS(amount), so a bound is a non-negative decimal: up to 12 integer digits
 * and 4 decimals (".5" is fine), no sign, no exponent. The API answers 400 to anything else and the filter inputs flag it before it
 * is sent (one rule, both sides).
 */
export const AMOUNT_BOUND_RE = /^(\d{1,12}(\.\d{1,4})?|\.\d{1,4})$/;
