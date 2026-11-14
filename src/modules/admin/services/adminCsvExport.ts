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

/** A filter value as recorded on the audit row: absent filters are null. */
export type ExportFilters = Record<string, string | boolean | null>;

function cellText(value: unknown): string | number | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** One CSV line: every value quoted and formula-neutralised; Date as ISO-8601. */
export function csvRow(values: readonly unknown[]): string {
  return values.map((v) => csvCell(cellText(v))).join(',');
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
  res.setHeader('Content-Disposition', `attachment; filename="${csv.filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).send(body);
}
