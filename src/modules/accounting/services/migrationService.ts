/**
 * Migration Service — Session management
 * PRD: Customer Migration Wizard — Phase 1
 *
 * CRUD for migration_sessions. See also:
 *   migrationCoaService.ts  — Chart of accounts import
 *   migrationContactService.ts — Customers + suppliers import
 *   migrationImportService.ts  — Opening balances + AR/AP invoices
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

// ── Shared types (re-exported for consumers) ─────────────────────────────────

export type MigrationStatus = 'in_progress' | 'completed' | 'abandoned';

export interface MigrationSession {
  id: string;
  companyId: string;
  sourceSystem: string | null;
  status: MigrationStatus;
  stepsCompleted: Record<string, boolean>;
  coaRecordsImported: number;
  customersImported: number;
  suppliersImported: number;
  openingBalancesSet: boolean;
  arInvoicesImported: number;
  apInvoicesImported: number;
  errors: MigrationError[];
  startedBy: string;
  startedAt: string;
  completedAt: string | null;
  notes: string | null;
}

export interface MigrationError {
  step: string;
  row?: number;
  field?: string;
  message: string;
}

export interface ImportResult {
  imported: number;
  skipped: number;
  errors: MigrationError[];
}

// ── Row mapper ───────────────────────────────────────────────────────────────

export function mapSessionRow(r: Row): MigrationSession {
  return {
    id: String(r.id),
    companyId: String(r.company_id),
    sourceSystem: r.source_system ?? null,
    status: r.status as MigrationStatus,
    stepsCompleted: (r.steps_completed as Record<string, boolean>) ?? {},
    coaRecordsImported: Number(r.coa_records_imported ?? 0),
    customersImported: Number(r.customers_imported ?? 0),
    suppliersImported: Number(r.suppliers_imported ?? 0),
    openingBalancesSet: Boolean(r.opening_balances_set),
    arInvoicesImported: Number(r.ar_invoices_imported ?? 0),
    apInvoicesImported: Number(r.ap_invoices_imported ?? 0),
    errors: (r.errors as MigrationError[]) ?? [],
    startedBy: String(r.started_by),
    startedAt: r.started_at instanceof Date ? r.started_at.toISOString() : String(r.started_at),
    completedAt: r.completed_at
      ? (r.completed_at instanceof Date ? r.completed_at.toISOString() : String(r.completed_at))
      : null,
    notes: r.notes ?? null,
  };
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function createSession(
  companyId: string,
  sourceSystem: string,
  userId: string,
): Promise<MigrationSession> {
  const rows = (await sql`
    INSERT INTO migration_sessions (company_id, source_system, started_by)
    VALUES (${companyId}::UUID, ${sourceSystem}, ${userId}::UUID)
    RETURNING *
  `) as Row[];
  log.info('Migration session created', { companyId, sourceSystem }, 'migration');
  return mapSessionRow(rows[0]);
}

export async function getSession(
  sessionId: string,
  companyId: string,
): Promise<MigrationSession | null> {
  const rows = (await sql`
    SELECT * FROM migration_sessions
    WHERE id = ${sessionId}::UUID AND company_id = ${companyId}::UUID
  `) as Row[];
  return rows.length > 0 ? mapSessionRow(rows[0]) : null;
}

export async function listSessions(companyId: string): Promise<MigrationSession[]> {
  const rows = (await sql`
    SELECT * FROM migration_sessions
    WHERE company_id = ${companyId}::UUID
    ORDER BY started_at DESC
  `) as Row[];
  return rows.map(mapSessionRow);
}

export async function updateSession(
  sessionId: string,
  companyId: string,
  updates: Partial<Pick<MigrationSession,
    | 'sourceSystem' | 'status' | 'stepsCompleted'
    | 'coaRecordsImported' | 'customersImported' | 'suppliersImported'
    | 'openingBalancesSet' | 'arInvoicesImported' | 'apInvoicesImported'
    | 'errors' | 'notes' | 'completedAt'
  >>,
): Promise<MigrationSession> {
  const rows = (await sql`
    UPDATE migration_sessions SET
      source_system        = COALESCE(${updates.sourceSystem ?? null}, source_system),
      status               = COALESCE(${updates.status ?? null}, status),
      steps_completed      = COALESCE(${updates.stepsCompleted ? JSON.stringify(updates.stepsCompleted) : null}::JSONB, steps_completed),
      coa_records_imported = COALESCE(${updates.coaRecordsImported ?? null}, coa_records_imported),
      customers_imported   = COALESCE(${updates.customersImported ?? null}, customers_imported),
      suppliers_imported   = COALESCE(${updates.suppliersImported ?? null}, suppliers_imported),
      opening_balances_set = COALESCE(${updates.openingBalancesSet ?? null}, opening_balances_set),
      ar_invoices_imported = COALESCE(${updates.arInvoicesImported ?? null}, ar_invoices_imported),
      ap_invoices_imported = COALESCE(${updates.apInvoicesImported ?? null}, ap_invoices_imported),
      errors               = COALESCE(${updates.errors ? JSON.stringify(updates.errors) : null}::JSONB, errors),
      notes                = COALESCE(${updates.notes ?? null}, notes),
      completed_at         = COALESCE(${updates.completedAt ?? null}::TIMESTAMPTZ, completed_at)
    WHERE id = ${sessionId}::UUID AND company_id = ${companyId}::UUID
    RETURNING *
  `) as Row[];
  return mapSessionRow(rows[0]);
}

export async function completeSession(
  sessionId: string,
  companyId: string,
): Promise<MigrationSession> {
  const rows = (await sql`
    UPDATE migration_sessions
    SET status = 'completed', completed_at = NOW()
    WHERE id = ${sessionId}::UUID AND company_id = ${companyId}::UUID
    RETURNING *
  `) as Row[];
  log.info('Migration session completed', { sessionId, companyId }, 'migration');
  return mapSessionRow(rows[0]);
}
