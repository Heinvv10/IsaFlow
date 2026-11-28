/**
 * SARS e@syFile field formatting and reference-number checks, per the SARS BRS
 * PAYE Employer Reconciliation (see easyFileExportService). Extracted from that
 * file, which re-exports all of it, to keep it under the 300-line cap.
 */

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

// ─── Field formatters ─────────────────────────────────────────────────────────

/**
 * BRS length types. A / AN / FT are quoted (§3(l)). N drops the cents; N_CENTS keeps them (§3(j)). ND is a number
 * written digit for digit (an ID, tax or PAYE reference: N13 / N10, where a leading 0 is part of the number). N4DP is
 * the N3.4 fixed decimal of the pay periods (3200 / 3210: "4 digits after the decimal point ... even if zero", p. 33).
 */
export type FieldType = 'A' | 'AN' | 'FT' | 'N' | 'N_CENTS' | 'ND' | 'N4DP';

/**
 * Characters a quoted (A / AN / FT) value must never carry, refused with a named error rather than stripped: filing
 * data is fixed at its source (the employee or company record), never silently changed on the certificate.
 * - comma and pipe: BRS V25.3.0 §3(h) p. 8, "No field must contain a comma (,) or a pipe (|) in the value";
 * - double quote: §3(l) p. 8 makes it the value's delimiter, and the Free Text list (p. 5) does not include it;
 * - control characters (C0 and DEL), CR and LF among them: the file is one "code,value" per line (CRLF), and the
 *   Free Text list (p. 5) admits none of them.
 * Without this an employee name or address carrying CR/LF or a quote could end its field and write fields or
 * records of its own (record and field injection).
 */
const FORBIDDEN_IN_QUOTED = /[\x00-\x1f\x7f",|]/;

function describeChar(ch: string): string {
  if (ch === ',') return 'a comma';
  if (ch === '|') return 'a pipe';
  if (ch === '"') return 'a double quote';
  return `a control character (U+${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')})`;
}

function assertNoForbiddenChars(value: string, code: number): void {
  const hit = FORBIDDEN_IN_QUOTED.exec(value);
  if (hit) {
    // The value itself is never echoed (PII breaker of #1944): the refusal reaches the 422 / EMP501 409 body and logs.
    throw new UsageError(`Field ${code} contains ${describeChar(hit[0])}, which the SARS e@syFile format does not allow. `
      + 'Correct it on the record it comes from.');
  }
}

/** BRS §3(m): data fields cannot start with a space. */
function assertNoLeadingSpace(value: string, code: number): void {
  if (value.startsWith(' ')) {
    throw new UsageError(`Field ${code} must not start with a space`);
  }
}

export function formatField(code: number, value: string | number | null, type: FieldType): string | null {
  if (value === null || value === undefined || value === '') return null;

  if (type === 'A' || type === 'AN' || type === 'FT') {
    const str = String(value);
    assertNoForbiddenChars(str, code);
    assertNoLeadingSpace(str, code);
    // BRS §3(l): Alpha / AN / FT wrapped in opening + closing double quotes.
    return `${code},"${str}"`;
  }

  if (type === 'ND') {
    const digits = String(value);
    if (!/^\d+$/.test(digits)) throw new UsageError(`Field ${code} must be digits only`);
    return `${code},${digits}`;
  }

  if (type === 'N4DP') {
    const num = Number(value);
    if (!Number.isFinite(num) || num < 0) throw new UsageError(`Field ${code} must be a number of 0 or more (BRS §3(g))`);
    return `${code},${num.toFixed(4)}`;
  }

  if (type === 'N_CENTS') {
    // Cents must be present with a decimal point (§3 and code-level rules for 4101/4102/4115/4141/4142/...).
    const num = Number(value);
    if (num < 0) throw new UsageError(`Field ${code} cannot be negative (BRS §3(g))`);
    return `${code},${num.toFixed(2)}`;
  }

  // Plain numeric — cents dropped, integer only (BRS §3(j)).
  const num = Number(value);
  if (num < 0) throw new UsageError(`Field ${code} cannot be negative (BRS §3(g))`);
  return `${code},${Math.floor(num)}`;
}

// ─── Validators for the critical employer ref numbers ─────────────────────────

/** BRS: code 2020 must be 10 numeric chars. Starts with 7 if registered for PAYE; otherwise 0/1/2/3/9. */
export function isValidPayeRef(value: string): boolean {
  return /^[01237][0-9]{9}$/.test(value);
}

/** BRS: code 2022 — L + 9 digits. */
export function isValidSdlRef(value: string): boolean {
  return /^L[0-9]{9}$/.test(value);
}

/** BRS: code 2024 — U + 9 digits. */
export function isValidUifRef(value: string): boolean {
  return /^U[0-9]{9}$/.test(value);
}

/** BRS: SARS income tax number — 10 numeric, first digit 0/1/2/3/9. */
export function isValidTaxNumber(value: string): boolean {
  return /^[01239][0-9]{9}$/.test(value);
}

/**
 * BRS V25.3.0 Appendix B §8.1 (pp. 117-118), "Modulus 10 check on Income Tax Number": digits 1, 3, 5, 7 and 9 are doubled
 * (a result above 9 has its two digits added, 18 -> 9), digits 2, 4, 6 and 8 are added as they are; digit 10 is 10 less the
 * last digit of the total, or 0 when that last digit is 0. The BRS's examples: 0001339050 (total 20) and 0667056642
 * (total 38) are valid. Applied to a PSP's 3100 (wave 6 PSP-H); not yet to a natural person's (it would refuse files
 * that export today: EZF's ruling).
 */
export function passesIncomeTaxModulus10(value: string): boolean {
  if (!/^\d{10}$/.test(value)) return false;
  let total = 0;
  for (let i = 0; i < 9; i++) {
    const d = Number(value[i]);
    const r = i % 2 === 0 ? d * 2 : d;
    total += r > 9 ? r - 9 : r;
  }
  const last = total % 10;
  return Number(value[9]) === (last === 0 ? 0 : 10 - last);
}
