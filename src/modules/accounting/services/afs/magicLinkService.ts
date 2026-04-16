/**
 * Magic Link Service
 * Generate and verify single-use magic link tokens for portal contacts.
 * Tokens expire after 30 minutes and are single-use (atomically consumed).
 */

import crypto from 'crypto';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { PortalContact, PortalRole } from './afsTypes';

const MAGIC_LINK_EXPIRY_MS = 30 * 60 * 1000; // 30 minutes

export async function createMagicLink(
  companyId: string,
  contactId: string,
): Promise<{ token: string; expiresAt: Date }> {
  const token = crypto.randomBytes(32).toString('hex'); // 64 hex chars, 256-bit entropy
  const expiresAt = new Date(Date.now() + MAGIC_LINK_EXPIRY_MS);

  // Invalidate any existing unused tokens for this contact (one active link at a time)
  await sql`
    UPDATE portal_magic_links
    SET used_at = now()
    WHERE contact_id = ${contactId}::UUID
      AND company_id = ${companyId}::UUID
      AND used_at IS NULL
      AND expires_at > now()
  `;

  await sql`
    INSERT INTO portal_magic_links (company_id, contact_id, token, expires_at)
    VALUES (${companyId}::UUID, ${contactId}::UUID, ${token}, ${expiresAt.toISOString()}::TIMESTAMPTZ)
  `;

  log.info('Magic link created', { companyId, contactId }, 'magicLinkService');
  return { token, expiresAt };
}

export async function verifyMagicLink(
  token: string,
): Promise<{ contact: PortalContact; companyId: string } | null> {
  // Step 1: Find the token (unused, not expired)
  const links = (await sql`
    SELECT id, company_id, contact_id
    FROM portal_magic_links
    WHERE token = ${token}
      AND used_at IS NULL
      AND expires_at > now()
    LIMIT 1
  `) as Record<string, unknown>[];

  if (links.length === 0) return null;

  const link = links[0] as { id: string; company_id: string; contact_id: string };

  // Step 2: Atomically mark as used (race condition guard)
  const updated = (await sql`
    UPDATE portal_magic_links
    SET used_at = now()
    WHERE id = ${link.id}::UUID AND used_at IS NULL
    RETURNING id
  `) as Record<string, unknown>[];

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
  await sql`
    DELETE FROM portal_magic_links
    WHERE expires_at < now() - INTERVAL '7 days'
  `;
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

