/**
 * Practice Report Recipients Service
 * CRUD for per-tenant email recipients of monthly practice management reports.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { DbRow } from '@/types/db';

// ─── Interfaces ───────────────────────────────────────────────────────────────

export interface ReportRecipient {
  id: string;
  companyId: string;
  email: string;
  name: string | null;
  reportTypes: string[];
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ReportRecipientInput {
  email: string;
  name?: string | null;
  reportTypes?: string[];
}

// ─── Mapper ───────────────────────────────────────────────────────────────────

function mapRow(r: DbRow): ReportRecipient {
  return {
    id: String(r.id),
    companyId: String(r.company_id),
    email: String(r.email),
    name: r.name ? String(r.name) : null,
    reportTypes: Array.isArray(r.report_types) ? r.report_types.map(String) : [],
    isActive: Boolean(r.is_active),
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
  };
}

// ─── Validation ───────────────────────────────────────────────────────────────

function validateEmail(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed || !trimmed.includes('@') || !trimmed.includes('.')) {
    throw new Error('valid email required');
  }
  return trimmed;
}

function isUniqueViolation(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    return msg.includes('unique') || msg.includes('duplicate') || msg.includes('23505');
  }
  return false;
}

// ─── Functions ────────────────────────────────────────────────────────────────

export async function listReportRecipients(
  companyId: string,
  activeOnly?: boolean,
): Promise<ReportRecipient[]> {
  const filterActive = activeOnly ?? false;
  const rows = (await sql`
    SELECT * FROM practice_report_recipients
    WHERE company_id = ${companyId}::UUID
      AND (${filterActive} = false OR is_active = true)
    ORDER BY created_at ASC
  `) as DbRow[];
  return rows.map(mapRow);
}

export async function createReportRecipient(
  companyId: string,
  createdBy: string,
  input: ReportRecipientInput,
): Promise<ReportRecipient> {
  const email = validateEmail(input.email);
  const name = input.name ?? null;
  const reportTypes = input.reportTypes ?? ['monthly_summary'];

  try {
    const rows = (await sql`
      INSERT INTO practice_report_recipients
        (company_id, email, name, report_types, created_by)
      VALUES (
        ${companyId}::UUID,
        ${email},
        ${name},
        ${reportTypes},
        ${createdBy}::UUID
      ) RETURNING *
    `) as DbRow[];
    if (!rows[0]) throw new Error('database returned no row after insert');
    log.info('Created report recipient', { id: rows[0].id, email }, 'practice');
    return mapRow(rows[0]);
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new Error('recipient already exists for this company');
    }
    throw err;
  }
}

export async function updateReportRecipient(
  companyId: string,
  id: string,
  input: Partial<ReportRecipientInput> & { isActive?: boolean },
): Promise<ReportRecipient> {
  const existing = (await sql`
    SELECT id FROM practice_report_recipients
    WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  if (!existing.length) throw new Error('not found');

  const email = input.email !== undefined ? validateEmail(input.email) : null;
  const name = input.name !== undefined ? (input.name ?? null) : null;
  const reportTypes = input.reportTypes ?? null;
  const isActive = input.isActive !== undefined ? input.isActive : null;

  const rows = (await sql`
    UPDATE practice_report_recipients SET
      email        = COALESCE(${email}, email),
      name         = CASE WHEN ${input.name !== undefined ? 'true' : 'false'} = 'true' THEN ${name} ELSE name END,
      report_types = COALESCE(${reportTypes}, report_types),
      is_active    = COALESCE(${isActive}, is_active),
      updated_at   = NOW()
    WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
    RETURNING *
  `) as DbRow[];

  if (!rows[0]) throw new Error('database returned no row after update');
  log.info('Updated report recipient', { id }, 'practice');
  return mapRow(rows[0]);
}

export async function deleteReportRecipient(
  companyId: string,
  id: string,
): Promise<void> {
  await sql`
    DELETE FROM practice_report_recipients
    WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
  `;
  log.info('Deleted report recipient', { id }, 'practice');
}
