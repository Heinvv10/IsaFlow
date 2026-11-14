/**
 * Admin CSV exports: one way to build a row and one way to send the file.
 *
 * Every cell goes through `csvCell` (`@/lib/csv`), which neutralises a leading
 * =, +, -, @, tab or CR (`neutralizeCsvCell`, CWE-1236) and quotes the value.
 *
 * `sendAuditedCsv` writes the admin audit row BEFORE a byte of the file goes out:
 * who (the request's admin), which export, the filters it applied and the row
 * count, never the data itself. `logAdminAction` fails closed, so an export whose
 * audit row cannot be written throws, withPlatformAdmin answers 500, and no CSV
 * leaves the server. The whole file is therefore built in memory first; a streamed
 * export would have sent its rows before its audit row was known to exist.
 */
import type { NextApiResponse } from 'next';
import type { PlatformAdminRequest } from '@/lib/auth';
import { csvCell } from '@/lib/csv';
import { getIp } from '@/utils/getIp';
import { logAdminAction } from './auditService';

/** The admin exports and the audit action each one records. */
const EXPORT_ACTIONS = {
  users: 'user.export',
  companies: 'company.export',
  subscriptions: 'subscription.export',
  web_analytics: 'web_analytics.export',
  audit: 'audit.export',
} as const;

export type AdminExport = keyof typeof EXPORT_ACTIONS;

/**
 * A filter value as recorded on the audit row: absent filters are null. Free-text
 * filters (a search box, a company name typed in) can hold personal information, so
 * routes record only whether one was set (`textFilterSet`); ids and dropdown values
 * are recorded as they are.
 */
export type ExportFilters = Record<string, string | boolean | null>;

/** Whether a free-text filter was applied: what the audit row says about it. */
export function textFilterSet(value: string | null): boolean {
  return value !== null;
}

/** Re-exported for the routes: the most rows one export may hold (shared with the pages). */
export { ADMIN_EXPORT_MAX_ROWS } from '@/components/admin/adminExportHref';

/** A plain signed decimal (`-5`, `12.50`): never a formula, so never neutralised. */
const PLAIN_DECIMAL = /^-?\d+(\.\d+)?$/;

function cell(value: unknown): string {
  if (value == null) return csvCell(null);
  if (value instanceof Date) return csvCell(value.toISOString());
  // A number cannot be a formula: -5 stays -5 (neutralising it would turn it into the text '-5). Still quoted.
  // That holds for a plain signed decimal string too (pg returns numeric/bigint columns as strings).
  if (typeof value === 'number') return `"${String(value)}"`;
  if (typeof value === 'string' && PLAIN_DECIMAL.test(value)) return `"${value}"`;
  if (typeof value === 'boolean') return csvCell(value ? 'true' : 'false');
  if (typeof value === 'object') return csvCell(JSON.stringify(value));
  return csvCell(String(value));
}

/** One CSV line: every value quoted; text formula-neutralised; numbers and plain decimals as they are; Date as ISO-8601. */
export function csvRow(values: readonly unknown[]): string {
  return values.map(cell).join(',');
}

/** A trimmed, non-empty query-string value, or null. */
export function queryText(value: string | string[] | undefined): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export interface AuditedCsv {
  export: AdminExport;
  /** File name without a directory; `.csv` included. */
  filename: string;
  filters: ExportFilters;
  header: readonly string[];
  /** Data lines, already built with csvRow. */
  lines: readonly string[];
}

/** Audits the export (fail-closed), then sends the CSV as one 200 response. */
export async function sendAuditedCsv(req: PlatformAdminRequest, res: NextApiResponse, csv: AuditedCsv): Promise<void> {
  await logAdminAction(
    req.user.id,
    EXPORT_ACTIONS[csv.export],
    'export',
    null,
    { export: csv.export, filters: csv.filters, row_count: csv.lines.length },
    getIp(req),
  );
  const body = [csvRow(csv.header), ...csv.lines].join('\n') + '\n';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  // Only safe characters reach the header, whatever a route built the name from.
  res.setHeader('Content-Disposition', `attachment; filename="${csv.filename.replace(/[^A-Za-z0-9._-]/g, '_')}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).send(body);
}
