/**
 * IMAP mirror poller — PRD-05 Phase 9.
 *
 * Connects to external mailboxes (generic IMAP for the MVP; Gmail + M365
 * get OAuth wrappers in follow-up services that produce an IMAP-compatible
 * auth blob). Walks INBOX from the stored UID cursor, pulls new messages,
 * filters by sender allow/deny list and invoice-shaped attachments, then
 * hands each candidate to the existing capture router.
 *
 * Invariant: the service never DELETEs or marks remote messages read.
 * Access is read-only — invoices stay where the user expects them.
 */

import { ImapFlow, type FetchMessageObject } from 'imapflow';
import { simpleParser, type ParsedMail, type Attachment } from 'mailparser';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { decrypt } from '@/lib/encryption';
import { sha256, storeCapturedBytes } from '@/lib/documentStorage';
import { routeEvent } from '@/modules/accounting/services/capture/captureRouterService';
import { runAfterCommit } from '@/lib/afterCommit';

type Row = Record<string, unknown>;

export interface MirrorConnection {
  id: string;
  companyId: string;
  provider: 'gmail' | 'm365' | 'imap';
  accountEmail: string;
  folder: string;
  scanCursor: Record<string, number>;
  allowedSenders: string[];
  deniedSenders: string[];
  // Generic IMAP creds
  imapHost: string | null;
  imapPort: number | null;
  imapUseTls: boolean;
  imapUsername: string | null;
  imapPasswordEnc: string | null;
  // OAuth providers
  oauthRefreshTokenEnc: string | null;
}

export interface ScanResult {
  connectionId: string;
  scanned: number;
  ingested: number;
  skipped: number;
  errors: number;
}

const ATTACHMENT_MIME_ALLOW = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/tiff',
]);
const INVOICE_SUBJECT_HINTS = [
  /invoice/i, /tax\s*invoice/i, /receipt/i, /statement/i,
  /credit\s*note/i, /bill/i, /purchase\s*order/i,
];

function loadMirrorRow(row: Row): MirrorConnection {
  return {
    id: row.id as string,
    companyId: row.company_id as string,
    provider: row.provider as 'gmail' | 'm365' | 'imap',
    accountEmail: row.account_email as string,
    folder: (row.folder as string) ?? 'INBOX',
    scanCursor: (row.scan_cursor as Record<string, number>) ?? {},
    allowedSenders: ((row.allowed_senders as string[]) ?? []).map(s => s.toLowerCase()),
    deniedSenders: ((row.denied_senders as string[]) ?? []).map(s => s.toLowerCase()),
    imapHost: (row.imap_host as string) ?? null,
    imapPort: row.imap_port != null ? Number(row.imap_port) : null,
    imapUseTls: Boolean(row.imap_use_tls ?? true),
    imapUsername: (row.imap_username as string) ?? null,
    imapPasswordEnc: (row.imap_password_enc as string) ?? null,
    oauthRefreshTokenEnc: (row.oauth_refresh_token_enc as string) ?? null,
  };
}

export async function listActiveConnections(): Promise<MirrorConnection[]> {
  const rows = (await sql`
    SELECT * FROM imap_mirror_connections
    WHERE status = 'active'
      AND (last_scan_at IS NULL
           OR last_scan_at < NOW() - (scan_interval_minutes || ' minutes')::INTERVAL)
    ORDER BY COALESCE(last_scan_at, '1970-01-01'::timestamptz) ASC
    LIMIT 20
  `) as Row[];
  return rows.map(loadMirrorRow);
}

export async function listConnectionsForCompany(companyId: string): Promise<MirrorConnection[]> {
  const rows = (await sql`
    SELECT * FROM imap_mirror_connections
    WHERE company_id = ${companyId}::uuid
    ORDER BY created_at DESC
  `) as Row[];
  return rows.map(loadMirrorRow);
}

export async function getConnection(id: string, companyId: string): Promise<MirrorConnection | null> {
  const rows = (await sql`
    SELECT * FROM imap_mirror_connections
    WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid
    LIMIT 1
  `) as Row[];
  return rows.length ? loadMirrorRow(rows[0]!) : null;
}

// ─── Sender filtering ─────────────────────────────────────────────────────────

function isSenderAllowed(conn: MirrorConnection, fromAddress: string): boolean {
  const addr = fromAddress.toLowerCase();
  const domain = addr.split('@')[1] ?? '';

  // Deny list wins
  if (conn.deniedSenders.some(rule => addr === rule || domain === rule)) return false;

  // Empty allow list = allow everything (minus deny)
  if (conn.allowedSenders.length === 0) return true;

  return conn.allowedSenders.some(rule => addr === rule || domain === rule);
}

function looksLikeInvoiceAttachment(att: Attachment): boolean {
  const mime = (att.contentType ?? '').toLowerCase();
  if (!ATTACHMENT_MIME_ALLOW.has(mime)) return false;
  if ((att.size ?? 0) === 0) return false;
  return true;
}

function subjectHintsInvoice(subject: string | null | undefined): boolean {
  if (!subject) return true; // don't reject on missing subject
  return INVOICE_SUBJECT_HINTS.some(re => re.test(subject));
}

// ─── IMAP connection ──────────────────────────────────────────────────────────

async function openImapClient(conn: MirrorConnection): Promise<ImapFlow> {
  if (conn.provider === 'imap') {
    if (!conn.imapHost || !conn.imapPort || !conn.imapUsername || !conn.imapPasswordEnc) {
      throw new Error(`Incomplete IMAP config for connection ${conn.id}`);
    }
    const password = decrypt(conn.imapPasswordEnc);
    return new ImapFlow({
      host: conn.imapHost,
      port: conn.imapPort,
      secure: conn.imapUseTls,
      auth: { user: conn.imapUsername, pass: password },
      logger: false,
    });
  }
  // Gmail / M365 use OAuth2 — actual token exchange handled by the provider-
  // specific service modules. For now, refuse to scan until those ship.
  throw new Error(`${conn.provider} OAuth flow not yet wired — pending Google/Microsoft app registration`);
}

// ─── Scanning ─────────────────────────────────────────────────────────────────

async function logScanEntry(
  conn: MirrorConnection,
  entry: {
    imapUid: string | null;
    sender: string | null;
    subject: string | null;
    attachmentCount: number;
    outcome: string;
    error?: string | null;
    captureEventIds?: string[];
  },
): Promise<void> {
  await sql`
    INSERT INTO imap_mirror_scan_log
      (connection_id, company_id, imap_uid, sender, subject,
       attachment_count, outcome, error, capture_event_ids)
    VALUES
      (${conn.id}::uuid, ${conn.companyId}::uuid, ${entry.imapUid},
       ${entry.sender}, ${entry.subject}, ${entry.attachmentCount},
       ${entry.outcome}, ${entry.error ?? null},
       ${entry.captureEventIds ?? null}::uuid[])
  `;
}

async function updateCursor(conn: MirrorConnection, folder: string, uid: number): Promise<void> {
  const nextCursor = { ...conn.scanCursor, [folder]: uid };
  await sql`
    UPDATE imap_mirror_connections
    SET scan_cursor = ${JSON.stringify(nextCursor)}::jsonb,
        last_scan_at = NOW(),
        last_success_at = NOW(),
        messages_ingested_total = messages_ingested_total
    WHERE id = ${conn.id}::uuid
  `;
}

async function markScanError(conn: MirrorConnection, error: string): Promise<void> {
  await sql`
    UPDATE imap_mirror_connections
    SET last_scan_at = NOW(),
        last_error = ${error},
        status = CASE WHEN status = 'active' THEN 'error' ELSE status END
    WHERE id = ${conn.id}::uuid
  `;
}

async function ingestAttachment(
  conn: MirrorConnection,
  parsed: ParsedMail,
  att: Attachment,
): Promise<string> {
  const content = att.content as Buffer;
  const sha = sha256(content);
  const mime = (att.contentType ?? 'application/octet-stream').toLowerCase();
  const filename = att.filename ?? `mirror-${sha.slice(0, 8)}`;

  // Create captured_documents row first — storeCapturedBytes needs the id
  // so it can scope the storage key.
  const [doc] = (await sql`
    INSERT INTO captured_documents (
      company_id, file_name, file_type, file_size, status,
      raw_bytes_sha256, raw_bytes_size
    ) VALUES (
      ${conn.companyId}::uuid, ${filename}, ${mime}, ${content.length},
      'pending', ${sha}, ${content.length}
    )
    RETURNING id
  `) as Row[];

  const documentId = String(doc!.id);

  // Upload the raw bytes + stamp the pointer
  const stored = await storeCapturedBytes(conn.companyId, documentId, content, mime);
  await sql`
    UPDATE captured_documents
    SET storage_bucket = ${stored.bucket}, storage_path = ${stored.path}
    WHERE id = ${documentId}::uuid
  `;

  // Find or synthesise the mirror inbox row, so capture_events can join
  const [inboxRow] = (await sql`
    INSERT INTO capture_inboxes (company_id, channel, address, is_active)
    VALUES (${conn.companyId}::uuid, 'imap_mirror', ${conn.accountEmail}, true)
    ON CONFLICT (company_id, channel, address)
    DO UPDATE SET is_active = true
    RETURNING id
  `) as Row[];

  const [event] = (await sql`
    INSERT INTO capture_events (
      company_id, inbox_id, channel, sender, subject,
      status, captured_document_id
    ) VALUES (
      ${conn.companyId}::uuid, ${inboxRow!.id as string}::uuid,
      'imap_mirror', ${parsed.from?.text ?? null}, ${parsed.subject ?? null},
      'received', ${documentId}::uuid
    )
    RETURNING id
  `) as Row[];

  const eventId = String(event!.id);

  // Hand off to router after the ingest commits — scan-now runs inside withAuth,
  // whose connection this must not outlive (R-075). The cron has no request
  // transaction, so there it starts immediately.
  runAfterCommit('imap mirror routeEvent', () => routeEvent(eventId, conn.companyId).catch((err) => {
    log.warn('routeEvent failed for mirror ingest', { eventId, err }, 'imap-mirror');
  }));

  return eventId;
}

export async function scanConnection(conn: MirrorConnection): Promise<ScanResult> {
  const result: ScanResult = {
    connectionId: conn.id,
    scanned: 0,
    ingested: 0,
    skipped: 0,
    errors: 0,
  };

  let client: ImapFlow | null = null;
  try {
    client = await openImapClient(conn);
    await client.connect();

    const lock = await client.getMailboxLock(conn.folder);
    try {
      const cursorUid = Number(conn.scanCursor[conn.folder] ?? 0);
      const searchRange = cursorUid > 0 ? `${cursorUid + 1}:*` : '1:*';

      // Fetch UIDs + minimal metadata first — don't pull bodies we don't want
      const msgs: FetchMessageObject[] = [];
      for await (const msg of client.fetch(searchRange, { uid: true, envelope: true, size: true })) {
        msgs.push(msg);
        if (msgs.length >= 50) break; // throttle per scan
      }

      let maxUidSeen = cursorUid;

      for (const meta of msgs) {
        result.scanned += 1;
        const uid = Number(meta.uid);
        if (uid > maxUidSeen) maxUidSeen = uid;

        const fromEntry = meta.envelope?.from?.[0];
        const fromAddr = fromEntry ? `${fromEntry.address}` : '';
        const subject = meta.envelope?.subject ?? null;

        if (!isSenderAllowed(conn, fromAddr)) {
          result.skipped += 1;
          await logScanEntry(conn, { imapUid: String(uid), sender: fromAddr,
            subject, attachmentCount: 0, outcome: 'denied_sender' });
          continue;
        }

        if (!subjectHintsInvoice(subject)) {
          result.skipped += 1;
          await logScanEntry(conn, { imapUid: String(uid), sender: fromAddr,
            subject, attachmentCount: 0, outcome: 'skipped_not_invoice' });
          continue;
        }

        // Pull the full message body now that the metadata filters pass
        const full = await client.fetchOne(String(uid), { source: true, uid: true });
        if (!full || !full.source) {
          result.skipped += 1;
          continue;
        }

        const parsed = await simpleParser(full.source);
        const attachments = (parsed.attachments ?? []).filter(looksLikeInvoiceAttachment);

        if (attachments.length === 0) {
          result.skipped += 1;
          await logScanEntry(conn, { imapUid: String(uid), sender: fromAddr,
            subject, attachmentCount: 0, outcome: 'skipped_no_attachment' });
          continue;
        }

        const eventIds: string[] = [];
        try {
          for (const att of attachments) {
            const eventId = await ingestAttachment(conn, parsed, att);
            eventIds.push(eventId);
          }
          result.ingested += eventIds.length;
          await logScanEntry(conn, { imapUid: String(uid), sender: fromAddr,
            subject, attachmentCount: attachments.length,
            outcome: 'ingested', captureEventIds: eventIds });
        } catch (ingestErr) {
          const msg = ingestErr instanceof Error ? ingestErr.message : String(ingestErr);
          result.errors += 1;
          log.warn('mirror ingest failed', { connectionId: conn.id, uid, err: msg }, 'imap-mirror');
          await logScanEntry(conn, { imapUid: String(uid), sender: fromAddr,
            subject, attachmentCount: attachments.length,
            outcome: 'error', error: msg });
        }
      }

      if (maxUidSeen > cursorUid) {
        await updateCursor(conn, conn.folder, maxUidSeen);
      } else {
        // Still bump last_scan_at so the poll interval kicks in correctly
        await sql`
          UPDATE imap_mirror_connections
          SET last_scan_at = NOW(), last_success_at = NOW()
          WHERE id = ${conn.id}::uuid
        `;
      }

      // Increment total ingested counter
      if (result.ingested > 0) {
        await sql`
          UPDATE imap_mirror_connections
          SET messages_ingested_total = messages_ingested_total + ${result.ingested}
          WHERE id = ${conn.id}::uuid
        `;
      }
    } finally {
      lock.release();
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('mirror scan failed', { connectionId: conn.id, err: msg }, 'imap-mirror');
    result.errors += 1;
    await markScanError(conn, msg);
  } finally {
    if (client) {
      try { await client.logout(); } catch { /* ignore */ }
    }
  }

  return result;
}

export async function scanAllDueConnections(): Promise<ScanResult[]> {
  const connections = await listActiveConnections();
  const results: ScanResult[] = [];
  for (const conn of connections) {
    results.push(await scanConnection(conn));
  }
  return results;
}
