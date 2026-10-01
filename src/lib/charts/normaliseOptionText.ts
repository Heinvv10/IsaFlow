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
 * Plain objects and arrays are copied. A FUNCTION under a label-producing key
 * (`LABEL_CALLBACKS`) is wrapped so what it RETURNS is normalised too — a
 * `formatter` builds label text from ledger data at draw time, after the
 * static strings have been cleaned — with `this` and `length` preserved.
 * Other functions, and class instances (ECharts' gradients hold colour stops,
 * not labels), pass through untouched. The caller's option is never mutated.
 * A cycle is an error naming the path, not a stack overflow.
 */
const TO_SPACE = /[\t\r\u2028\u2029]/g;
const DROPPED = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\ufeff\ufffe\uffff]/g;

/** The callback keys the pack's options (and ECharts) use for text or the
 *  elements that carry it: tooltip/label/axis formatters, series colour
 *  callbacks, and the custom series' `renderItem`, whose returned element
 *  descriptors hold `style.text`. */
export const LABEL_CALLBACKS: ReadonlySet<string> = new Set([
  'formatter', 'valueFormatter', 'color', 'renderItem',
]);

export function cleanOptionString(s: string): string {
  return s.replace(TO_SPACE, ' ').replace(DROPPED, '');
}

function isPlain(v: object): boolean {
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

function wrapCallback<F extends (...args: never[]) => unknown>(fn: F): F {
  const wrapped = function (this: unknown, ...args: never[]) {
    return normaliseValue(fn.apply(this, args), '(returned)', []);
  } as unknown as F;
  Object.defineProperty(wrapped, 'length', { value: fn.length });
  return wrapped;
}

function normaliseValue(value: unknown, path: string, ancestors: object[]): unknown {
  if (typeof value === 'string') return cleanOptionString(value);
  if (typeof value !== 'object' || value === null) return value;
  if (!Array.isArray(value) && !isPlain(value)) return value;
  if (ancestors.includes(value)) {
    throw new Error(`normaliseOptionText: the chart option is circular at ${path}`);
  }
  const next = [...ancestors, value];
  if (Array.isArray(value)) return value.map((v, i) => normaliseValue(v, `${path}[${i}]`, next));
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [
      cleanOptionString(k),
      typeof v === 'function' && LABEL_CALLBACKS.has(k)
        ? wrapCallback(v as (...args: never[]) => unknown)
        : normaliseValue(v, `${path}.${k}`, next),
    ]),
  );
}

export function normaliseOptionText<T>(value: T): T {
  return normaliseValue(value, 'option', []) as T;
}
