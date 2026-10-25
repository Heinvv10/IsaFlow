/**
 * Sent-mirror connection CRUD — PRD-06 Phase 6.
 *
 * Tenant-scoped wrappers around sent_mirror_connections for the settings
 * UI. Mirrors the shape of capture/mirrorConnectionService.ts but talks to
 * the outbound table. Credentials encrypted at rest via lib/encryption.ts.
 *
 * Every write here runs on the migration_admin pool (S-07e part B, migration
 * 946): no app role may write a sent_mirror_connections row at all (the
 * scan's own stamps are sentMirrorWrites.ts's, also on migration_admin). Re-pointing a victim's
 * imap_host/port/tls/username makes the scan cron decrypt the victim's stored
 * mailbox password and send it to the attacker's server. `companyId` is the
 * verified request's; the role bypasses RLS, so every statement carries
 * `company_id = $n`.
 */

import { sql } from '@/lib/neon';
import { migrationAdminTx } from '@/lib/auth/migrationAdminPool';
import { encrypt } from '@/lib/encryption';
import { log } from '@/lib/logger';

type Row = Record<string, unknown>;

export interface SentMirrorSummary {
  id: string;
  provider: 'gmail' | 'm365' | 'imap';
  displayName: string;
  accountEmail: string;
  status: 'active' | 'disconnected' | 'error';
  sentFolder: string;
  scanIntervalMinutes: number;
  messagesCapturedTotal: number;
  messagesLinkedTotal: number;
  lastScanAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  createdAt: string;
}

function mapSummary(row: Row): SentMirrorSummary {
  return {
    id: row.id as string,
    provider: row.provider as 'gmail' | 'm365' | 'imap',
    displayName: (row.display_name as string) ?? '',
    accountEmail: row.account_email as string,
    status: row.status as 'active' | 'disconnected' | 'error',
    sentFolder: (row.sent_folder as string) ?? 'Sent',
    scanIntervalMinutes: Number(row.scan_interval_minutes ?? 10),
    messagesCapturedTotal: Number(row.messages_captured_total ?? 0),
    messagesLinkedTotal: Number(row.messages_linked_total ?? 0),
    lastScanAt: row.last_scan_at ? String(row.last_scan_at) : null,
    lastSuccessAt: row.last_success_at ? String(row.last_success_at) : null,
    lastError: (row.last_error as string) ?? null,
    createdAt: String(row.created_at),
  };
}

export async function listSentConnectionSummaries(companyId: string): Promise<SentMirrorSummary[]> {
  const rows = (await sql`
    SELECT * FROM sent_mirror_connections
    WHERE company_id = ${companyId}::uuid
    ORDER BY created_at DESC
  `) as Row[];
  return rows.map(mapSummary);
}

export interface CreateSentImapInput {
  companyId: string;
  createdBy?: string | null;
  displayName: string;
  accountEmail: string;
  imapHost: string;
  imapPort: number;
  imapUseTls?: boolean;
  imapUsername: string;
  imapPassword: string;
  sentFolder?: string;
  scanIntervalMinutes?: number;
}

export async function createSentImapConnection(input: CreateSentImapInput): Promise<SentMirrorSummary> {
  const enc = encrypt(input.imapPassword);
  const [row] = await migrationAdminTx('create sent mirror connection', async (client) => (await client.query(
    `INSERT INTO sent_mirror_connections (
       company_id, created_by, provider, display_name, account_email,
       imap_host, imap_port, imap_use_tls, imap_username, imap_password_enc,
       sent_folder, scan_interval_minutes
     ) VALUES (
       $1::uuid, $2, 'imap', $3, $4, $5, $6, $7, $8, $9, $10, $11
     )
     RETURNING *`,
    [input.companyId, input.createdBy ?? null, input.displayName, input.accountEmail,
      input.imapHost, input.imapPort, input.imapUseTls ?? true, input.imapUsername, enc,
      input.sentFolder ?? 'Sent', input.scanIntervalMinutes ?? 10],
  )).rows as Row[]);
  log.info('sent mirror connection created (imap)', { id: row!.id, companyId: input.companyId }, 'sent-mirror');
  return mapSummary(row!);
}

export interface UpdateSentConnectionInput {
  id: string;
  companyId: string;
  sentFolder?: string;
  scanIntervalMinutes?: number;
}

export async function updateSentConnection(input: UpdateSentConnectionInput): Promise<SentMirrorSummary | null> {
  const rows = await migrationAdminTx('update sent mirror connection', async (client) => (await client.query(
    `UPDATE sent_mirror_connections
        SET sent_folder           = COALESCE($3, sent_folder),
            scan_interval_minutes = COALESCE($4::int, scan_interval_minutes)
      WHERE id = $1::uuid AND company_id = $2::uuid
      RETURNING *`,
    [input.id, input.companyId, input.sentFolder ?? null, input.scanIntervalMinutes ?? null],
  )).rows as Row[]);
  return rows.length ? mapSummary(rows[0]!) : null;
}

export async function disconnectSentConnection(id: string, companyId: string): Promise<boolean> {
  const rows = await migrationAdminTx('disconnect sent mirror connection', async (client) => (await client.query(
    `UPDATE sent_mirror_connections
        SET status = 'disconnected',
            disconnected_at = NOW(),
            oauth_refresh_token_enc = NULL,
            imap_password_enc = NULL
      WHERE id = $1::uuid AND company_id = $2::uuid
      RETURNING id`,
    [id, companyId],
  )).rows as Row[]);
  if (rows.length > 0) {
    log.info('sent mirror connection disconnected', { id, companyId }, 'sent-mirror');
  }
  return rows.length > 0;
}

export async function deleteSentConnection(id: string, companyId: string): Promise<boolean> {
  const rows = await migrationAdminTx('delete sent mirror connection', async (client) => (await client.query(
    `DELETE FROM sent_mirror_connections
      WHERE id = $1::uuid AND company_id = $2::uuid
      RETURNING id`,
    [id, companyId],
  )).rows as Row[]);
  return rows.length > 0;
}

export async function listSentScanLog(id: string, companyId: string, limit = 50): Promise<Row[]> {
  return await sql`
    SELECT id, imap_uid, recipient, subject, attachment_count,
           outcome, error, linked_invoice_ids, captured_document_ids, scanned_at
    FROM sent_mirror_scan_log
    WHERE connection_id = ${id}::uuid AND company_id = ${companyId}::uuid
    ORDER BY scanned_at DESC
    LIMIT ${limit}
  ` as Row[];
}
