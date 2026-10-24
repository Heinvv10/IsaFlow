/**
 * Magic Link Service
 * Generate and verify single-use magic link tokens for portal contacts.
 * Tokens expire after 30 minutes and are single-use (atomically consumed).
 *
 * Every read and write of portal_magic_links runs on the migration_admin pool
 * (S-07d, migration 935): a row holds the raw token that signs a contact in,
 * so a row planted or read from an app pool (forged claims) was a portal
 * session for any company. No app role holds any privilege on the table.
 */

import crypto from 'crypto';
import { migrationAdminTx } from '@/lib/auth/migrationAdminPool';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { listLiveCompanies } from '@/lib/auth/liveCompanies';
import type { PortalContact, PortalRole } from './afsTypes';

const MAGIC_LINK_EXPIRY_MS = 30 * 60 * 1000; // 30 minutes

export async function createMagicLink(
  companyId: string,
  contactId: string,
): Promise<{ token: string; expiresAt: Date }> {
  const token = crypto.randomBytes(32).toString('hex'); // 64 hex chars, 256-bit entropy
  const expiresAt = new Date(Date.now() + MAGIC_LINK_EXPIRY_MS);

  await migrationAdminTx('create portal magic link', async (client) => {
    // Invalidate any existing unused tokens for this contact (one active link at a time)
    await client.query(
      `UPDATE portal_magic_links
          SET used_at = now()
        WHERE contact_id = $1::UUID
          AND company_id = $2::UUID
          AND used_at IS NULL
          AND expires_at > now()`,
      [contactId, companyId],
    );
    await client.query(
      `INSERT INTO portal_magic_links (company_id, contact_id, token, expires_at)
       VALUES ($1::UUID, $2::UUID, $3, $4::TIMESTAMPTZ)`,
      [companyId, contactId, token, expiresAt.toISOString()],
    );
  });

  log.info('Magic link created', { companyId, contactId }, 'magicLinkService');
  return { token, expiresAt };
}

export async function verifyMagicLink(
  token: string,
): Promise<{ contact: PortalContact; companyId: string } | null> {
  // Step 1: Find the token (unused, not expired)
  const links = await migrationAdminTx('find portal magic link', async (client) => (await client.query(
    `SELECT id, company_id, contact_id
       FROM portal_magic_links
      WHERE token = $1
        AND used_at IS NULL
        AND expires_at > now()
      LIMIT 1`,
    [token],
  )).rows as Record<string, unknown>[]);

  if (links.length === 0) return null;

  const link = links[0] as { id: string; company_id: string; contact_id: string };

  // A link minted before its company was suspended or deleted signs in to
  // nothing (audit S-08 breaker REPRO 3): the same live test the request used.
  if ((await listLiveCompanies([link.company_id])).length === 0) {
    log.warn('Magic link refused: company is not live', { linkId: link.id, companyId: link.company_id }, 'magicLinkService');
    return null;
  }

  // Step 2: Atomically mark as used (race condition guard)
  const updated = await migrationAdminTx('consume portal magic link', async (client) => (await client.query(
    `UPDATE portal_magic_links
        SET used_at = now()
      WHERE id = $1::UUID AND used_at IS NULL
      RETURNING id`,
    [link.id],
  )).rows as Record<string, unknown>[]);

  if (updated.length === 0) {
    log.warn('Magic link consumed by concurrent request', { linkId: link.id }, 'magicLinkService');
    return null;
  }

  // Step 3: Load the portal contact (cross-validates company_id)
  const contacts = (await sql`
    SELECT id, company_id, name, email, role, active, created_at, updated_at
    FROM portal_contacts
    WHERE id = ${link.contact_id}::UUID
      AND company_id = ${link.company_id}::UUID
      AND active = true
    LIMIT 1
  `) as Record<string, unknown>[];

  if (contacts.length === 0) {
    log.warn(
      'Magic link verified but contact inactive or missing',
      { contactId: link.contact_id },
      'magicLinkService',
    );
    return null;
  }

  const contact = mapContactRow(contacts[0]!);
  log.info('Magic link verified', { contactId: contact.id, companyId: link.company_id }, 'magicLinkService');
  return { contact, companyId: String(link.company_id) };
}

export async function cleanupExpiredMagicLinks(): Promise<void> {
  await migrationAdminTx('clean up portal magic links', (client) => client.query(
    `DELETE FROM portal_magic_links WHERE expires_at < now() - INTERVAL '7 days'`,
  ));
  log.info('Expired magic links cleaned up', {}, 'magicLinkService');
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function mapContactRow(row: Record<string, unknown>): PortalContact {
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

