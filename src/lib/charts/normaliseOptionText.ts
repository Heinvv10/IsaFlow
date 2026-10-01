/**
 * TEXT THAT CANNOT SURVIVE THE SVG GRAMMAR IS CLEANED BEFORE IT IS DRAWN.
 *
 * The grammar refuses any control character, U+2028/2029 or BOM in a chart —
 * correctly, since the browser reads those differently from a scan. But labels
 * are LEDGER DATA, and one mis-decoded Sage account name carrying a stray
 * control byte would then refuse the whole chart and with it the pack. So the
 * option's strings are normalised on the way in, recursively, and the grammar
 * stays strict: C0/C1 controls are removed (a line feed is kept, as a
 * multi-line label is legitimate), tab and carriage return become a space,
 * U+2028/2029 become a space, and a BOM is dropped.
 *
 * Plain objects and arrays are copied; anything else — a function, a gradient
 * instance, a Date — is passed through untouched, so an option's callbacks and
 * ECharts' own classes keep working. The caller's option is never mutated.
 */
const TO_SPACE = /[\t\r\u2028\u2029]/g;
const DROPPED = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\ufeff\ufffe\uffff]/g;

export function cleanOptionString(s: string): string {
  return s.replace(TO_SPACE, ' ').replace(DROPPED, '');
}

function isPlain(v: object): boolean {
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

export function normaliseOptionText<T>(value: T): T {
  if (typeof value === 'string') return cleanOptionString(value) as T;
  if (Array.isArray(value)) return value.map((v) => normaliseOptionText(v)) as T;
  if (typeof value === 'object' && value !== null && isPlain(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [cleanOptionString(k), normaliseOptionText(v)]),
    ) as T;
  }
  return value;
}
