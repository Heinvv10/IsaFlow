/**
 * Portal Contacts Service
 * CRUD for portal contacts. All queries tenant-scoped by company_id.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { PortalContact, PortalRole } from './afsTypes';

const VALID_ROLES: PortalRole[] = ['director', 'cfo', 'shareholder_readonly', 'external_auditor'];

function mapRow(row: Record<string, unknown>): PortalContact {
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    name: String(row.name),
    email: String(row.email),
    role: row.role as PortalRole,
    active: Boolean(row.active),
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(String(row.created_at)),
    updatedAt: row.updated_at instanceof Date ? row.updated_at : new Date(String(row.updated_at)),
  };
}

export async function listPortalContacts(companyId: string): Promise<PortalContact[]> {
  const rows = (await sql`
    SELECT id, company_id, name, email, role, active, created_at, updated_at
    FROM portal_contacts
    WHERE company_id = ${companyId}::UUID AND active = true
    ORDER BY name ASC
  `) as Record<string, unknown>[];
  return rows.map(mapRow);
}

export async function getPortalContactByEmail(
  companyId: string,
  email: string,
): Promise<PortalContact | null> {
  const rows = (await sql`
    SELECT id, company_id, name, email, role, active, created_at, updated_at
    FROM portal_contacts
    WHERE company_id = ${companyId}::UUID AND email = ${email} AND active = true
    LIMIT 1
  `) as Record<string, unknown>[];
  if (rows.length === 0) return null;
  return mapRow(rows[0]!);
}

export async function createPortalContact(
  companyId: string,
  input: { name: string; email: string; role: PortalRole },
): Promise<PortalContact> {
  if (!VALID_ROLES.includes(input.role)) {
    throw new Error('INVALID_ROLE');
  }
  try {
    const rows = (await sql`
      INSERT INTO portal_contacts (company_id, name, email, role)
      VALUES (${companyId}::UUID, ${input.name}, ${input.email}, ${input.role})
      RETURNING id, company_id, name, email, role, active, created_at, updated_at
    `) as Record<string, unknown>[];
    log.info('Portal contact created', { companyId, email: input.email, role: input.role }, 'portalContactsService');
    return mapRow(rows[0]!);
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes('unique')) {
      throw new Error('DUPLICATE_EMAIL');
    }
    throw err;
  }
}

export async function updatePortalContact(
  companyId: string,
  contactId: string,
  input: Partial<{ name: string; role: PortalRole; active: boolean }>,
): Promise<PortalContact> {
  // IDOR guard: verify the contact belongs to this company
  const existing = (await sql`
    SELECT id FROM portal_contacts
    WHERE id = ${contactId}::UUID AND company_id = ${companyId}::UUID
  `) as Record<string, unknown>[];
  if (existing.length === 0) {
    throw new Error('CONTACT_NOT_FOUND');
  }

  const rows = (await sql`
    UPDATE portal_contacts
    SET name       = COALESCE(${input.name ?? null}, name),
        role       = COALESCE(${input.role ?? null}, role),
        active     = COALESCE(${input.active ?? null}, active),
        updated_at = now()
    WHERE id = ${contactId}::UUID AND company_id = ${companyId}::UUID
    RETURNING id, company_id, name, email, role, active, created_at, updated_at
  `) as Record<string, unknown>[];
  log.info('Portal contact updated', { companyId, contactId }, 'portalContactsService');
  return mapRow(rows[0]!);
}

export async function deletePortalContact(companyId: string, contactId: string): Promise<void> {
  await sql`
    UPDATE portal_contacts
    SET active = false, updated_at = now()
    WHERE id = ${contactId}::UUID AND company_id = ${companyId}::UUID
  `;
  log.info('Portal contact soft-deleted', { companyId, contactId }, 'portalContactsService');
}
