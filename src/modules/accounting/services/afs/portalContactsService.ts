/**
 * Portal Contacts Service
 * CRUD for portal contacts. All queries tenant-scoped by company_id.
 *
 * The writes run on the migration_admin pool (S-07d, migration 937): an
 * active contact is who may ask for a portal sign-in link, with the role the
 * portal grants, so a contact planted or re-addressed from an app pool
 * (forged claims) was portal access to any company. `companyId` is the
 * verified request's; the routes gate the caller's role (withWriteAccess).
 */

import { sql } from '@/lib/neon';
import { migrationAdminTx } from '@/lib/auth/migrationAdminPool';
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
    const rows = await migrationAdminTx('create portal contact', async (client) => (await client.query(
      `INSERT INTO portal_contacts (company_id, name, email, role)
       VALUES ($1::UUID, $2, $3, $4)
       RETURNING id, company_id, name, email, role, active, created_at, updated_at`,
      [companyId, input.name, input.email, input.role],
    )).rows as Record<string, unknown>[]);
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
  // IDOR guard: the contact must belong to this company
  const rows = await migrationAdminTx('update portal contact', async (client) => (await client.query(
    `UPDATE portal_contacts
        SET name       = COALESCE($3, name),
            role       = COALESCE($4, role),
            active     = COALESCE($5, active),
            updated_at = now()
      WHERE id = $1::UUID AND company_id = $2::UUID
      RETURNING id, company_id, name, email, role, active, created_at, updated_at`,
    [contactId, companyId, input.name ?? null, input.role ?? null, input.active ?? null],
  )).rows as Record<string, unknown>[]);
  if (rows.length === 0) {
    throw new Error('CONTACT_NOT_FOUND');
  }
  log.info('Portal contact updated', { companyId, contactId }, 'portalContactsService');
  return mapRow(rows[0]!);
}

export async function deletePortalContact(companyId: string, contactId: string): Promise<void> {
  await migrationAdminTx('deactivate portal contact', (client) => client.query(
    `UPDATE portal_contacts SET active = false, updated_at = now()
      WHERE id = $1::UUID AND company_id = $2::UUID`,
    [contactId, companyId],
  ));
  log.info('Portal contact soft-deleted', { companyId, contactId }, 'portalContactsService');
}
