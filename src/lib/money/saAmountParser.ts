/**
 * Parse a South African money string to integer cents, once, at the form boundary.
 *
 * Accepts "25 000,00", "25,000.00", "R 1 234.56", "1234.5", "(123.45)" and "-123.45",
 * with ordinary, non-breaking, narrow and thin spaces as thousands separators.
 *
 * Refuses input that has more than one reading ("1,234" is 1234 or 1.234) rather than
 * guessing: SimplePay read "25,000.00" as R25 because a thousands comma looked like a
 * decimal separator. A refusal carries a `reason` the field shows to the user.
 *
 * Pure: no Decimal, no float arithmetic. Cents are built from the digit string.
 */
import { formatMoney } from '@/lib/money/formatMoney';

export type AmountParseCode = 'empty' | 'ambiguous' | 'malformed' | 'decimals' | 'chars' | 'too_large';

export type AmountParseResult =
  | { ok: true; cents: number }
  | { ok: false; code: AmountParseCode; reason: string };

const fail = (code: AmountParseCode, reason: string): AmountParseResult => ({ ok: false, code, reason });

const UNICODE_SPACES = /[     ]/g;
const CURRENCY = /^(?:ZAR|R)\s*/i;
const LEADING_MINUS = /^[-−]\s*/;
const DECIMALS_MSG = 'Amounts have at most two decimal places.';

/** Sign, brackets and the R / ZAR marker stripped off; what is left is the number. */
function splitSign(s: string): { negative: boolean; body: string } {
  const bracketed = /^\(\s*(?:(?:ZAR|R)\s*)?([^()]*?)\s*\)$/i.exec(s) ?? /^(?:ZAR|R)\s*\(\s*([^()]*?)\s*\)$/i.exec(s);
  if (bracketed) return { negative: true, body: bracketed[1] ?? '' };
  let rest = s;
  let negative = false;
  if (LEADING_MINUS.test(rest)) {
    negative = true;
    rest = rest.replace(LEADING_MINUS, '');
  }
  rest = rest.replace(CURRENCY, '');
  if (!negative && LEADING_MINUS.test(rest)) {
    negative = true;
    rest = rest.replace(LEADING_MINUS, '');
  }
  return { negative, body: rest.trim() };
}

/** 1-3 digits, then groups of exactly three, joined by `sep`: the only valid thousands grouping. */
function isGrouped(text: string, sep: string): boolean {
  const groups = text.split(sep);
  return groups.every((g, i) => (i === 0 ? /^\d{1,3}$/.test(g) : /^\d{3}$/.test(g)));
}

export function parseSaAmount(input: string): AmountParseResult {
  const shown = input.trim();
  const malformed = (): AmountParseResult =>
    fail('malformed', `"${shown}" is not a valid amount. Try 25 000.00 or 25,000.00.`);

  const text = input.replace(UNICODE_SPACES, ' ').replace(/\s+/g, ' ').trim();
  const { negative, body } = splitSign(text);
  if (body === '') return fail('empty', 'Enter an amount.');
  if (!/^[\d .,]+$/.test(body)) {
    return /[A-Za-z$€£]/.test(body)
      ? fail('chars', 'Use digits only, with an optional R, minus sign or brackets.')
      : malformed();
  }

  const commas = (body.match(/,/g) ?? []).length;
  const dots = (body.match(/\./g) ?? []).length;
  const spaced = body.includes(' ');
  let decimal: ',' | '.' | null = null;
  let thousands: ' ' | ',' | '.' | null = spaced ? ' ' : null;

  if (commas > 0 && dots > 0) {
    if (spaced) return malformed();
    decimal = body.lastIndexOf(',') > body.lastIndexOf('.') ? ',' : '.';
    thousands = decimal === ',' ? '.' : ',';
    if ((decimal === ',' ? commas : dots) !== 1) return malformed();
  } else if (commas + dots > 0) {
    const sep: ',' | '.' = commas > 0 ? ',' : '.';
    if (commas + dots > 1) {
      if (spaced) return malformed();
      thousands = sep;
    } else {
      const at = body.indexOf(sep);
      const before = body.slice(0, at);
      const after = body.slice(at + 1);
      if (after === '') return malformed();
      if (after.length > 3) return fail('decimals', DECIMALS_MSG);
      if (after.length === 3) {
        if (spaced || !/^[1-9]\d{0,2}$/.test(before)) return fail('decimals', DECIMALS_MSG);
        return fail(
          'ambiguous',
          `"${shown}" is ambiguous: it could be ${before} ${after}.00 (a thousands separator) or a decimal with ` +
            `three places. Type ${before} ${after}.00 or ${before}${after}.00.`,
        );
      }
      decimal = sep;
    }
  }

  const split = decimal ? body.lastIndexOf(decimal) : -1;
  const intText = split >= 0 ? body.slice(0, split) : body;
  const frac = split >= 0 ? body.slice(split + 1) : '';
  if (frac.length > 2) return fail('decimals', DECIMALS_MSG);
  if (split >= 0 && !/^\d{1,2}$/.test(frac)) return malformed();

  let intDigits = intText;
  if (thousands !== null) {
    if (!isGrouped(intText, thousands)) return malformed();
    intDigits = intText.split(thousands).join('');
  } else if (!/^\d*$/.test(intText)) {
    return malformed();
  }
  if (intDigits === '' && decimal === null) return malformed();

  const digits = `${intDigits}${frac.padEnd(2, '0')}`.replace(/^0+(?=\d)/, '');
  const cents = Number(digits);
  if (digits.length > 16 || !Number.isSafeInteger(cents)) {
    return fail('too_large', 'That amount is too large to be a valid figure.');
  }
  return { ok: true, cents: negative && cents !== 0 ? -cents : cents };
}

/** "25 000.00" / "-123.45": space-grouped, dot decimal. Parses back to the same cents. */
export function formatCentsPlain(cents: number): string {
  return formatMoney(cents / 100).replace(/,/g, '\u00A0').replace(/^(-?)R /, '$1');
}

/** "R 25 000.00": space-grouped (no comma that could be read as a decimal), dot decimal. */
export function formatCentsEcho(cents: number): string {
  return formatMoney(cents / 100).replace(/,/g, '\u00A0');
}
