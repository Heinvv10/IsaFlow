/**
 * Capture Inbox Service
 * Manages capture_inboxes — mint, rotate, list per company.
 *
 * Mint and rotate run on the migration_admin pool (S-07d, migration 937): an
 * inbox row decides which company the documents mailed to its address go to,
 * so no app role may INSERT or UPDATE capture_inboxes (forged claims moved a
 * company's address to another company). `companyId` is the verified request's.
 */

import crypto from 'crypto';
import { sql } from '@/lib/neon';
import type { PoolClient } from 'pg';
import { migrationAdminTx } from '@/lib/auth/migrationAdminPool';
import { log } from '@/lib/logger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Inbox {
  id: string;
  companyId: string;
  channel: string;
  address: string;
  isActive: boolean;
  allowedSenderDomains: string[] | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

type InboxRow = Record<string, unknown>;

function mapInbox(row: InboxRow): Inbox {
  return {
    id: row.id as string,
    companyId: row.company_id as string,
    channel: row.channel as string,
    address: row.address as string,
    isActive: row.is_active as boolean,
    allowedSenderDomains: (row.allowed_sender_domains as string[] | null) ?? null,
    createdBy: row.created_by as string | null,
    createdAt: new Date(row.created_at as string).toISOString(),
    updatedAt: new Date(row.updated_at as string).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** PURE — generate a new candidate inbox address (never writes DB). */
export function generateInboxAddress(companyId: string): string {
  // Use companyId only to satisfy the parameter; actual uniqueness comes from
  // random bytes so we don't expose the UUID in the address.
  void companyId;
  const slug = crypto.randomBytes(16).toString('hex');
  return `cap-${slug}@inbox.isaflow.co.za`;
}

// ---------------------------------------------------------------------------
// DB operations
// ---------------------------------------------------------------------------

/**
 * Look up the existing active email inbox, or mint a new one with up to 5
 * retry-on-conflict attempts.
 */
export async function getOrCreateEmailInbox(
  companyId: string,
  userId?: string,
): Promise<{ id: string; address: string; isActive: boolean }> {
  // Try existing first
  const existing = await sql`
    SELECT id, address, is_active FROM capture_inboxes
    WHERE company_id = ${companyId} AND channel = 'email' AND is_active = true
    LIMIT 1
  ` as InboxRow[];

  if (existing.length > 0) {
    const row = existing[0]!;
    return { id: row.id as string, address: row.address as string, isActive: row.is_active as boolean };
  }

  return migrationAdminTx('mint capture inbox', (client) => mintEmailInbox(client, companyId, userId));
}

/**
 * Mint a new active address, retrying a unique-constraint collision up to 5
 * times. A conflict must not abort the caller's transaction: an empty
 * RETURNING means retry; SQL/network errors remain errors rather than guessed
 * collisions.
 */
async function mintEmailInbox(
  client: PoolClient,
  companyId: string,
  userId?: string,
): Promise<{ id: string; address: string; isActive: boolean }> {
  const MAX_ATTEMPTS = 5;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const address = generateInboxAddress(companyId);
    const row = (await client.query(
      `INSERT INTO capture_inboxes (company_id, channel, address, is_active, created_by)
       VALUES ($1, 'email', $2, true, $3)
       ON CONFLICT DO NOTHING
       RETURNING id, address, is_active`,
      [companyId, address, userId ?? null],
    )).rows[0] as InboxRow | undefined;
    if (row) {
      log.info('Created email capture inbox', { companyId, address, attempt }, 'capture-inbox');
      return { id: row.id as string, address: row.address as string, isActive: row.is_active as boolean };
    }
    log.warn('Address collision — retrying', { attempt, address }, 'capture-inbox');
  }
  throw new Error('Failed to mint unique inbox address after 5 attempts');
}

/**
 * Deactivate all existing email inboxes for the company and mint a new one,
 * in one transaction: a mint that fails leaves the old address active.
 */
export async function regenerateEmailAddress(
  companyId: string,
  userId?: string,
): Promise<{ id: string; address: string }> {
  const result = await migrationAdminTx('rotate capture inbox', async (client) => {
    await client.query(
      `UPDATE capture_inboxes
          SET is_active = false, updated_at = NOW()
        WHERE company_id = $1 AND channel = 'email' AND is_active = true`,
      [companyId],
    );
    return mintEmailInbox(client, companyId, userId);
  });
  log.info('Regenerated email capture inbox', { companyId, newAddress: result.address }, 'capture-inbox');
  return { id: result.id, address: result.address };
}

/** List all inboxes for a company across all channels. */
export async function listInboxes(companyId: string): Promise<Inbox[]> {
  const rows = await sql`
    SELECT * FROM capture_inboxes
    WHERE company_id = ${companyId}
    ORDER BY created_at DESC
  ` as InboxRow[];

  return rows.map(mapInbox);
}
