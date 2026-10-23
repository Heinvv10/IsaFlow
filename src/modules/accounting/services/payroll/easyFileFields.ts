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

type FieldType = 'A' | 'AN' | 'FT' | 'N' | 'N_CENTS';

/** BRS §3: no commas or pipes are allowed inside values (rule h). */
function assertNoForbiddenChars(value: string, code: number): void {
  if (value.includes(',') || value.includes('|')) {
    throw new UsageError(`Field ${code} contains a forbidden character (comma or pipe): "${value}"`);
  }
}

/** BRS §3(m): data fields cannot start with a space. */
function assertNoLeadingSpace(value: string, code: number): void {
  if (value.startsWith(' ')) {
    throw new UsageError(`Field ${code} must not start with a space: "${value}"`);
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
