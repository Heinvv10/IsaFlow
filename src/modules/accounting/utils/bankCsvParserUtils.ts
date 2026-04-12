/**
 * Bank CSV Parser — Shared Utilities
 * Low-level CSV parsing helpers shared by all bank-specific parsers.
 */

/**
 * Parse a CSV string into lines, handling quoted fields.
 */
export function parseCsvLines(csv: string): string[][] {
  if (!csv || csv.trim() === '') return [];

  const lines = csv.trim().split('\n');
  return lines.map(line => {
    const fields: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        fields.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    fields.push(current.trim());
    return fields;
  });
}

/**
 * Parse amount string, handling thousand separators and negative values.
 */
export function parseAmount(value: string): number | null {
  if (!value || value.trim() === '') return null;
  const cleaned = value.replace(/[,\s]/g, '').replace(/^["']|["']$/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

/**
 * Convert date string to YYYY-MM-DD format.
 */
export function normalizeDate(
  dateStr: string,
  format: 'yyyy/mm/dd' | 'dd/mm/yyyy' | 'yyyy-mm-dd',
): string | null {
  const cleaned = dateStr.trim().replace(/^["']|["']$/g, '').trim();
  if (!cleaned) return null;

  let year: string, month: string, day: string;

  if (format === 'yyyy/mm/dd') {
    const parts = cleaned.split('/');
    if (parts.length !== 3) return null;
    year = parts[0]!; month = parts[1]!; day = parts[2]!;
  } else if (format === 'dd/mm/yyyy') {
    const parts = cleaned.split('/');
    if (parts.length !== 3) return null;
    day = parts[0]!; month = parts[1]!; year = parts[2]!;
  } else if (format === 'yyyy-mm-dd') {
    const parts = cleaned.split('-');
    if (parts.length !== 3) return null;
    year = parts[0]!; month = parts[1]!; day = parts[2]!;
  } else {
    return null;
  }

  const y = parseInt(year, 10);
  const m = parseInt(month, 10);
  const d = parseInt(day, 10);
  if (isNaN(y) || isNaN(m) || isNaN(d)) return null;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;

  return `${year.padStart(4, '0')}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}
