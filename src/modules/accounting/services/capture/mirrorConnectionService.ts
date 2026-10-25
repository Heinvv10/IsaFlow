/**
 * Mirror-inbox connection CRUD — PRD-05 Phase 9.
 *
 * Thin tenant-scoped wrappers around imap_mirror_connections for the
 * settings UI. All credentials are encrypted at rest via the shared
 * AES-256-GCM helper in src/lib/encryption.ts.
 *
 * Every write here runs on the migration_admin login in routeAdminPool.ts's pool
 * (S-07e part B, migration 946), not the credential pool that sign-in shares: each
 * is one fixed statement in a transaction of its own that waits at most 2 s for the
 * row (55P03 after that: the route answers 503). No app role may write a imap_mirror_connections
 * row at all (the scan's own stamps are imapMirrorWrites.ts's, also on migration_admin).
 * Re-pointing a victim's
 * imap_host/port/tls/username makes the scan cron decrypt the victim's stored
 * mailbox password and send it to the attacker's server. `companyId` is the
 * verified request's; the role bypasses RLS, so every statement carries
 * `company_id = $n`.
 */

import { sql } from '@/lib/neon';
import { routeAdminQuery, routeAdminTx } from '@/lib/auth/routeAdminPool';
import { encrypt } from '@/lib/encryption';
import { log } from '@/lib/logger';
import { assertUnderConnectionCap } from './mirrorLimits';

type Row = Record<string, unknown>;

export interface MirrorConnectionSummary {
  id: string;
  provider: 'gmail' | 'm365' | 'imap';
  displayName: string;
  accountEmail: string;
  status: 'active' | 'disconnected' | 'error';
  folder: string;
  scanIntervalMinutes: number;
  allowedSenders: string[];
  deniedSenders: string[];
  messagesIngestedTotal: number;
  lastScanAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  createdAt: string;
}

function mapSummary(row: Row): MirrorConnectionSummary {
  return {
    id: row.id as string,
    provider: row.provider as 'gmail' | 'm365' | 'imap',
    displayName: (row.display_name as string) ?? '',
    accountEmail: row.account_email as string,
    status: row.status as 'active' | 'disconnected' | 'error',
    folder: (row.folder as string) ?? 'INBOX',
    scanIntervalMinutes: Number(row.scan_interval_minutes ?? 5),
    allowedSenders: (row.allowed_senders as string[]) ?? [],
    deniedSenders: (row.denied_senders as string[]) ?? [],
    messagesIngestedTotal: Number(row.messages_ingested_total ?? 0),
    lastScanAt: row.last_scan_at ? String(row.last_scan_at) : null,
    lastSuccessAt: row.last_success_at ? String(row.last_success_at) : null,
    lastError: (row.last_error as string) ?? null,
    createdAt: String(row.created_at),
  };
}

export async function listMirrorConnections(companyId: string): Promise<MirrorConnectionSummary[]> {
  const rows = (await sql`
    SELECT * FROM imap_mirror_connections
    WHERE company_id = ${companyId}::uuid
    ORDER BY created_at DESC
  `) as Row[];
  return rows.map(mapSummary);
}

export interface CreateImapConnectionInput {
  companyId: string;
  createdBy?: string | null;
  displayName: string;
  accountEmail: string;
  imapHost: string;
  imapPort: number;
  imapUseTls?: boolean;
  imapUsername: string;
  imapPassword: string;                      // plain text — encrypted at rest
  folder?: string;
  scanIntervalMinutes?: number;
  allowedSenders?: string[];
  deniedSenders?: string[];
}

export async function createImapConnection(input: CreateImapConnectionInput): Promise<MirrorConnectionSummary> {
  const enc = encrypt(input.imapPassword);
  // Under the company's cap (mirrorLimits.ts): the count and the INSERT are one transaction behind a per-company lock.
  const row = await routeAdminTx('create imap mirror connection', async (client) => {
    await assertUnderConnectionCap(client, 'imap', input.companyId);
    const { rows } = await client.query(
      `INSERT INTO imap_mirror_connections (
         company_id, created_by, provider, display_name, account_email,
         imap_host, imap_port, imap_use_tls, imap_username, imap_password_enc,
         folder, scan_interval_minutes, allowed_senders, denied_senders
       ) VALUES (
         $1::uuid, $2, 'imap', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::text[], $13::text[]
       )
       RETURNING *`,
      [input.companyId, input.createdBy ?? null, input.displayName, input.accountEmail,
        input.imapHost, input.imapPort, input.imapUseTls ?? true, input.imapUsername, enc,
        input.folder ?? 'INBOX', input.scanIntervalMinutes ?? 5,
        input.allowedSenders ?? [], input.deniedSenders ?? []],
    );
    return rows[0] as Row;
  });
  log.info('mirror connection created (imap)', { id: row.id, companyId: input.companyId }, 'imap-mirror');
  return mapSummary(row);
}

export interface UpdateSendersInput {
  id: string;
  companyId: string;
  allowedSenders?: string[];
  deniedSenders?: string[];
  scanIntervalMinutes?: number;
  folder?: string;
}

export async function updateConnectionSenders(input: UpdateSendersInput): Promise<MirrorConnectionSummary | null> {
  const rows = await routeAdminQuery('update imap mirror connection',
    `UPDATE imap_mirror_connections
        SET allowed_senders = COALESCE($3::text[], allowed_senders),
            denied_senders  = COALESCE($4::text[], denied_senders),
            scan_interval_minutes = COALESCE($5::int, scan_interval_minutes),
            folder          = COALESCE($6, folder)
      WHERE id = $1::uuid AND company_id = $2::uuid
      RETURNING *`,
    [input.id, input.companyId, input.allowedSenders ?? null, input.deniedSenders ?? null,
      input.scanIntervalMinutes ?? null, input.folder ?? null],
  );
  return rows.length ? mapSummary(rows[0]!) : null;
}

export async function disconnectConnection(id: string, companyId: string): Promise<boolean> {
  const rows = await routeAdminQuery('disconnect imap mirror connection',
    `UPDATE imap_mirror_connections
        SET status = 'disconnected',
            disconnected_at = NOW(),
            oauth_refresh_token_enc = NULL,
            imap_password_enc = NULL
      WHERE id = $1::uuid AND company_id = $2::uuid
      RETURNING id`,
    [id, companyId],
  );
  if (rows.length > 0) {
    log.info('mirror connection disconnected', { id, companyId }, 'imap-mirror');
  }
  return rows.length > 0;
}

export async function reactivateConnection(id: string, companyId: string): Promise<boolean> {
  const rows = await routeAdminQuery('reactivate imap mirror connection',
    `UPDATE imap_mirror_connections
        SET status = 'active',
            last_error = NULL,
            disconnected_at = NULL
      WHERE id = $1::uuid AND company_id = $2::uuid
      RETURNING id`,
    [id, companyId],
  );
  return rows.length > 0;
}

export async function deleteConnection(id: string, companyId: string): Promise<boolean> {
  const rows = await routeAdminQuery('delete imap mirror connection',
    `DELETE FROM imap_mirror_connections
      WHERE id = $1::uuid AND company_id = $2::uuid
      RETURNING id`,
    [id, companyId],
  );
  return rows.length > 0;
}

export async function listScanLog(id: string, companyId: string, limit = 50): Promise<Row[]> {
  return await sql`
    SELECT id, imap_uid, sender, subject, attachment_count,
           outcome, error, capture_event_ids, scanned_at
    FROM imap_mirror_scan_log
    WHERE connection_id = ${id}::uuid AND company_id = ${companyId}::uuid
    ORDER BY scanned_at DESC
    LIMIT ${limit}
  ` as Row[];
}
