/**
 * External payslip CSV parser (parallel-run import) — pure, no DB.
 *
 * Column contract (header row required; names case-insensitive; comma or
 * semicolon delimited — auto-detected from the header line):
 *   employee_number  REQUIRED  aliases: employee code, employee no, emp no, code
 *   employee_name    optional  aliases: name, full name, employee
 *   gross            aliases: gross pay, gross remuneration, gross income
 *   paye             aliases: tax, paye tax
 *   uif_employee     aliases: uif ee, uif employee
 *   uif_employer     aliases: uif er, uif employer, uif company
 *   uif              total employee+employer — used when the export doesn't split
 *   sdl
 *   eti
 *   net              aliases: net pay, nett, nett pay, take home
 *
 * At least one amount column is required. Amounts accept SA formats:
 * "R 1 234.56", "1,234.56", "1234,56", "(123.45)" (negative). Blank cells are
 * zero (payslip exports leave zeros blank). Output amounts are integer cents.
 */

import type {
  ComparisonComponentKey,
  CsvParseError,
  ExternalCsvParseResult,
  ExternalPayslipRow,
} from './payrollParallelRunTypes';

const COLUMN_ALIASES: Record<string, ComparisonComponentKey> = {
  'gross': 'gross', 'gross pay': 'gross', 'gross remuneration': 'gross', 'gross income': 'gross',
  'paye': 'paye', 'tax': 'paye', 'paye tax': 'paye',
  'uif employee': 'uifEmployee', 'uif ee': 'uifEmployee',
  'uif employer': 'uifEmployer', 'uif er': 'uifEmployer', 'uif company': 'uifEmployer',
  'uif': 'uifTotal', 'uif total': 'uifTotal',
  'sdl': 'sdl',
  'eti': 'eti',
  'net': 'net', 'net pay': 'net', 'nett': 'net', 'nett pay': 'net', 'take home': 'net',
};

const NUMBER_ALIASES = new Set([
  'employee number', 'employee no', 'employee code', 'emp no', 'emp number', 'code',
]);
const NAME_ALIASES = new Set(['employee name', 'name', 'full name', 'employee']);

/** Normalize a header cell: lowercase, underscores/extra space → single space. */
function normalizeHeader(cell: string): string {
  return cell.trim().toLowerCase().replace(/[_\s]+/g, ' ');
}

/**
 * Parse one amount cell to integer cents using string math (no float).
 * Returns null when the cell is not a recognizable amount.
 */
export function parseAmountToCents(raw: string): number | null {
  let s = raw.trim();
  if (s === '') return 0;

  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1).trim();
  }
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1);
  }
  s = s.replace(/^R/i, '').replace(/[\s ']/g, '');
  if (s === '' || !/^[\d.,]+$/.test(s)) return null;

  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  let decimalSep: string | null = null;
  if (lastComma >= 0 && lastDot >= 0) {
    decimalSep = lastComma > lastDot ? ',' : '.';
    // Mixed separators: the decimal one may appear only once.
    if (s.split(decimalSep).length !== 2) return null;
  } else if (lastComma >= 0) {
    // Lone comma: decimal only when single occurrence with 1–2 trailing digits.
    const after = s.length - lastComma - 1;
    const single = s.indexOf(',') === lastComma;
    decimalSep = single && (after === 1 || after === 2) ? ',' : null;
  } else if (lastDot >= 0) {
    decimalSep = '.';
  }

  let intPart: string;
  let decPart = '';
  if (decimalSep) {
    const idx = s.lastIndexOf(decimalSep);
    intPart = s.slice(0, idx);
    decPart = s.slice(idx + 1);
    if (decPart.includes('.') || decPart.includes(',')) return null;
  } else {
    intPart = s;
  }
  intPart = intPart.replace(/[.,]/g, '');
  if (!/^\d*$/.test(intPart) || !/^\d*$/.test(decPart)) return null;
  if (intPart === '' && decPart === '') return null;

  // Round half away from zero on the 3rd decimal digit.
  const dec3 = (decPart + '000').slice(0, 3);
  let cents = Number(intPart || '0') * 100 + Number(dec3.slice(0, 2));
  if (Number(dec3[2]) >= 5) cents += 1;
  return negative ? -cents : cents;
}

/** Split one CSV line honouring double-quoted fields. */
function splitLine(line: string, delim: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delim) {
      out.push(cur); cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

export function parseExternalPayslipCsv(csv: string): ExternalCsvParseResult {
  const errors: CsvParseError[] = [];
  const lines = csv.split(/\r\n|\r|\n/);
  const headerIdx = lines.findIndex((l) => l.trim() !== '');
  if (headerIdx < 0) {
    return { rows: [], errors: [{ line: 0, message: 'File is empty' }], componentsPresent: [] };
  }

  const headerLine = lines[headerIdx] ?? '';
  const delim = headerLine.split(';').length > headerLine.split(',').length ? ';' : ',';
  const headers = splitLine(headerLine, delim).map(normalizeHeader);

  let numberCol = -1;
  let nameCol = -1;
  const componentCols = new Map<number, ComparisonComponentKey>();
  headers.forEach((h, i) => {
    if (NUMBER_ALIASES.has(h)) numberCol = i;
    else if (NAME_ALIASES.has(h)) nameCol = i;
    else if (COLUMN_ALIASES[h]) componentCols.set(i, COLUMN_ALIASES[h]);
  });

  if (numberCol < 0) {
    errors.push({ line: headerIdx + 1, message: 'No employee number column found (expected e.g. "employee_number" or "Employee Code")' });
  }
  if (componentCols.size === 0) {
    errors.push({ line: headerIdx + 1, message: 'No amount column found (expected e.g. gross, paye, uif, sdl, eti, net)' });
  }
  if (errors.length > 0) {
    return { rows: [], errors, componentsPresent: [] };
  }

  const rows: ExternalPayslipRow[] = [];
  const seen = new Set<string>();
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const lineNo = i + 1;
    const lineRaw = lines[i] ?? '';
    if (lineRaw.trim() === '') continue;
    const cells = splitLine(lineRaw, delim);

    const employeeNumber = (cells[numberCol] ?? '').trim();
    if (employeeNumber === '') {
      errors.push({ line: lineNo, message: 'Missing employee number' });
      continue;
    }
    const dedupeKey = employeeNumber.toUpperCase();
    if (seen.has(dedupeKey)) {
      errors.push({ line: lineNo, message: `Duplicate employee number "${employeeNumber}"` });
      continue;
    }

    const amounts: ExternalPayslipRow['amounts'] = {};
    let bad = false;
    for (const [col, key] of componentCols) {
      const cents = parseAmountToCents(cells[col] ?? '');
      if (cents === null) {
        errors.push({ line: lineNo, message: `Unparseable amount "${(cells[col] ?? '').trim()}" in column ${key}` });
        bad = true;
        break;
      }
      amounts[key] = cents;
    }
    if (bad) continue;

    seen.add(dedupeKey);
    rows.push({
      employeeNumber,
      employeeName: nameCol >= 0 ? (cells[nameCol] ?? '').trim() || null : null,
      amounts,
    });
  }

  return { rows, errors, componentsPresent: [...new Set(componentCols.values())] };
}
