/**
 * Practice Client Bulk Service
 * CSV export and import for practice_clients.
 *
 * Importable columns (case-insensitive header match):
 *   legal_name        (required)
 *   trading_name      (optional)
 *   registration_no   (optional)
 *   tax_no            (optional)
 *   billing_model     (required: hourly | fixed | retainer)
 *   status            (required: prospect | onboarding | active | inactive | archived)
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { DbRow } from '@/types/db';
import { escapeCsv } from '@/lib/csv';

export type BillingModel = 'hourly' | 'fixed' | 'retainer';
export type ClientStatus = 'prospect' | 'onboarding' | 'active' | 'inactive' | 'archived';

const BILLING_MODELS: ReadonlySet<BillingModel> = new Set(['hourly', 'fixed', 'retainer']);
const CLIENT_STATUSES: ReadonlySet<ClientStatus> = new Set([
  'prospect', 'onboarding', 'active', 'inactive', 'archived',
]);

export interface ClientImportRow {
  legalName: string;
  tradingName: string | null;
  registrationNo: string | null;
  taxNo: string | null;
  billingModel: BillingModel;
  status: ClientStatus;
}

export interface ClientImportError {
  rowNumber: number; // 1-indexed, excludes header row
  message: string;
}

export interface ParseCsvResult {
  rows: ClientImportRow[];
  errors: ClientImportError[];
}

export interface ImportResult {
  created: number;
  skipped: number;
  errors: ClientImportError[];
}

export interface ClientExportRow {
  legal_name: string;
  trading_name: string | null;
  registration_no: string | null;
  tax_no: string | null;
  billing_model: string;
  status: string;
}

const CSV_HEADER = [
  'legal_name', 'trading_name', 'registration_no', 'tax_no', 'billing_model', 'status',
] as const;

// ─── CSV utilities (pure) ─────────────────────────────────────────────────────

export function buildClientsCsv(rows: ClientExportRow[]): string {
  const lines: string[] = [CSV_HEADER.join(',')];
  for (const r of rows) {
    lines.push([
      escapeCsv(r.legal_name),
      escapeCsv(r.trading_name),
      escapeCsv(r.registration_no),
      escapeCsv(r.tax_no),
      escapeCsv(r.billing_model),
      escapeCsv(r.status),
    ].join(','));
  }
  return lines.join('\n');
}

/**
 * RFC 4180-ish CSV row parser. Handles quoted fields with embedded commas,
 * escaped quotes (""), and CR/LF inside quoted fields.
 */
function parseCsvRows(csv: string): string[][] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  let i = 0;
  while (i < csv.length) {
    const ch = csv[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (csv[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"') { inQuotes = true; i++; continue; }
    if (ch === ',') { row.push(field); field = ''; i++; continue; }
    if (ch === '\r') {
      if (csv[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = ''; i++; continue;
    }
    if (ch === '\n') {
      row.push(field); rows.push(row); row = []; field = ''; i++; continue;
    }
    field += ch; i++;
  }
  // Trailing field/row (file with no trailing newline)
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // Strip trailing empty row that some editors append
  while (rows.length > 0 && rows[rows.length - 1]!.every((f) => f === '')) {
    rows.pop();
  }
  return rows;
}

function trim(value: string | undefined): string {
  return (value ?? '').trim();
}

function nullIfBlank(value: string | undefined): string | null {
  const v = trim(value);
  return v === '' ? null : v;
}

export function parseClientsCsv(csv: string): ParseCsvResult {
  const rows: ClientImportRow[] = [];
  const errors: ClientImportError[] = [];

  const matrix = parseCsvRows(csv);
  if (matrix.length === 0) {
    errors.push({ rowNumber: 0, message: 'CSV is empty' });
    return { rows, errors };
  }

  const headerRow = matrix[0]!.map((h) => h.trim().toLowerCase());
  const colIndex: Record<string, number> = {};
  for (const name of CSV_HEADER) {
    colIndex[name] = headerRow.indexOf(name);
  }

  if (colIndex.legal_name === -1) {
    errors.push({ rowNumber: 0, message: 'Missing required header: legal_name' });
  }
  if (colIndex.billing_model === -1) {
    errors.push({ rowNumber: 0, message: 'Missing required header: billing_model' });
  }
  if (colIndex.status === -1) {
    errors.push({ rowNumber: 0, message: 'Missing required header: status' });
  }
  if (errors.length > 0) return { rows, errors };

  const seenNames = new Set<string>();

  for (let r = 1; r < matrix.length; r++) {
    const cells = matrix[r]!;
    const rowNumber = r; // 1-indexed across data rows
    const legalName = trim(cells[colIndex.legal_name!]);
    const billingModelRaw = trim(cells[colIndex.billing_model!]).toLowerCase();
    const statusRaw = trim(cells[colIndex.status!]).toLowerCase();

    if (legalName === '' && billingModelRaw === '' && statusRaw === '') {
      continue; // skip wholly blank lines
    }

    if (legalName === '') {
      errors.push({ rowNumber, message: 'legal_name is required' });
      continue;
    }
    if (!BILLING_MODELS.has(billingModelRaw as BillingModel)) {
      errors.push({
        rowNumber,
        message: `billing_model must be one of: ${[...BILLING_MODELS].join(', ')}`,
      });
      continue;
    }
    if (!CLIENT_STATUSES.has(statusRaw as ClientStatus)) {
      errors.push({
        rowNumber,
        message: `status must be one of: ${[...CLIENT_STATUSES].join(', ')}`,
      });
      continue;
    }
    const dedupeKey = legalName.toLowerCase();
    if (seenNames.has(dedupeKey)) {
      errors.push({ rowNumber, message: `Duplicate legal_name within file: ${legalName}` });
      continue;
    }
    seenNames.add(dedupeKey);

    rows.push({
      legalName,
      tradingName: colIndex.trading_name! >= 0 ? nullIfBlank(cells[colIndex.trading_name!]) : null,
      registrationNo: colIndex.registration_no! >= 0 ? nullIfBlank(cells[colIndex.registration_no!]) : null,
      taxNo: colIndex.tax_no! >= 0 ? nullIfBlank(cells[colIndex.tax_no!]) : null,
      billingModel: billingModelRaw as BillingModel,
      status: statusRaw as ClientStatus,
    });
  }

  return { rows, errors };
}

// ─── DB operations ────────────────────────────────────────────────────────────

/**
 * Export clients for the given company. If `ids` is provided, only those.
 * Otherwise exports all non-archived clients.
 */
export async function bulkExportClients(
  companyId: string,
  ids?: string[],
): Promise<ClientExportRow[]> {
  if (ids && ids.length > 0) {
    const rows = (await sql`
      SELECT legal_name, trading_name, registration_no, tax_no, billing_model, status
      FROM practice_clients
      WHERE company_id = ${companyId}::UUID
        AND id = ANY(${ids}::UUID[])
      ORDER BY legal_name ASC
    `) as DbRow[];
    return rows.map(toExportRow);
  }
  const rows = (await sql`
    SELECT legal_name, trading_name, registration_no, tax_no, billing_model, status
    FROM practice_clients
    WHERE company_id = ${companyId}::UUID
    ORDER BY legal_name ASC
  `) as DbRow[];
  return rows.map(toExportRow);
}

function toExportRow(r: DbRow): ClientExportRow {
  return {
    legal_name: String(r.legal_name),
    trading_name: r.trading_name ? String(r.trading_name) : null,
    registration_no: r.registration_no ? String(r.registration_no) : null,
    tax_no: r.tax_no ? String(r.tax_no) : null,
    billing_model: String(r.billing_model),
    status: String(r.status),
  };
}

/**
 * Import client rows. Skips any whose legal_name already exists for the
 * company (case-sensitive, matching createPracticeClient's duplicate guard).
 */
export async function bulkImportClients(
  companyId: string,
  rows: ClientImportRow[],
): Promise<ImportResult> {
  if (rows.length === 0) {
    return { created: 0, skipped: 0, errors: [] };
  }

  const names = rows.map((r) => r.legalName);
  const existingRows = (await sql`
    SELECT legal_name FROM practice_clients
    WHERE company_id = ${companyId}::UUID
      AND legal_name = ANY(${names}::TEXT[])
  `) as DbRow[];
  const existing = new Set(existingRows.map((r) => String(r.legal_name)));

  let created = 0;
  let skipped = 0;
  const errors: ClientImportError[] = [];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    if (existing.has(r.legalName)) {
      skipped++;
      continue;
    }
    try {
      await sql`
        INSERT INTO practice_clients (
          company_id, legal_name, trading_name, registration_no, tax_no,
          billing_model, status
        ) VALUES (
          ${companyId}::UUID, ${r.legalName},
          ${r.tradingName}, ${r.registrationNo}, ${r.taxNo},
          ${r.billingModel}, ${r.status}
        )
      `;
      created++;
      existing.add(r.legalName);
    } catch (err) {
      errors.push({
        rowNumber: i + 1,
        message: err instanceof Error ? err.message : 'insert failed',
      });
    }
  }

  log.info('Practice client bulk import', { companyId, created, skipped, errors: errors.length }, 'practice');
  return { created, skipped, errors };
}
