/**
 * Browser-side CSV export utility using papaparse.
 * Only call `downloadCsv` inside onClick handlers — never at module scope (SSR-safe).
 */

import Papa from 'papaparse';
import { neutralizeCsvCell } from '@/lib/csvSafe';

export interface CsvColumn<T> {
  header: string;
  accessor: (row: T) => string | number | null;
}

/**
 * Serialise rows to CSV and trigger a browser download.
 * Empty `rows` → downloads a header-only file (so users still get schema).
 */
export function downloadCsv<T>(filename: string, columns: CsvColumn<T>[], rows: T[]): void {
  const fields = columns.map((c) => c.header);
  const data = rows.map((r) =>
    columns.map((c) => {
      const v = c.accessor(r);
      return v == null ? '' : (typeof v === 'string' ? neutralizeCsvCell(v) : v);
    }),
  );
  const csv = Papa.unparse({ fields, data });
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename.endsWith('.csv') ? filename : `${filename}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/** Filename for date-range reports: `practice-utilisation-2026-04-01-to-2026-04-19` */
export function reportFilename(reportName: string, from: string, to: string): string {
  return `practice-${reportName}-${from}-to-${to}`;
}

/** Filename for as-of reports: `practice-wip-aging-asof-2026-04-19` */
export function asOfFilename(reportName: string, asOfDate: string): string {
  return `practice-${reportName}-asof-${asOfDate}`;
}
