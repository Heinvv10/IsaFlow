/**
 * Sent-folder mirror poller — PRD-06 Phase 6.
 *
 * Watches the Sent folder of a connected mailbox (IMAP for the MVP; Gmail
 * and M365 will wrap the same interface with OAuth later). For every
 * outbound message with a PDF attachment we:
 *
 *   1. sha256 the attachment bytes.
 *   2. SELECT captured_documents WHERE company_id, raw_bytes_sha256 — this
 *      catches the invoice snapshot Phase 1 sealed on send, plus any other
 *      outbound PDFs the app has already hashed.
 *   3. Hit  → log 'linked_to_invoice', no new row, increment link counter.
 *      Miss → INSERT captured_documents (document_type='outbound_email'),
 *             upload bytes, increment capture counter.
 *
 * Invariant: the service is read-only against the remote mailbox. It never
 * marks messages read, moves, or deletes.
 *
 * Invariant: link-back is company-scoped. A sha256 hash collision across
 * tenants still yields two separate captured_documents rows.
 */

import { ImapFlow, type FetchMessageObject } from 'imapflow';
import { simpleParser, type ParsedMail, type Attachment } from 'mailparser';

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { decrypt } from '@/lib/encryption';
import { sha256, storeCapturedBytes } from '@/lib/documentStorage';

type Row = Record<string, unknown>;

export interface SentMirrorConnection {
  id: string;
  companyId: string;
  provider: 'gmail' | 'm365' | 'imap';
  accountEmail: string;
  sentFolder: string;
  scanCursor: Record<string, number>;
  imapHost: string | null;
  imapPort: number | null;
  imapUseTls: boolean;
  imapUsername: string | null;
  imapPasswordEnc: string | null;
  oauthRefreshTokenEnc: string | null;
}

export interface SentMirrorScanResult {
  connectionId: string;
  scanned: number;
  linked: number;
  captured: number;
  skipped: number;
  errors: number;
}

const ATTACHMENT_MIME_ALLOW = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/jpg',
]);

function loadConnection(row: Row): SentMirrorConnection {
  return {
    id: row.id as string,
    companyId: row.company_id as string,
    provider: row.provider as 'gmail' | 'm365' | 'imap',
    accountEmail: row.account_email as string,
    sentFolder: (row.sent_folder as string) ?? 'Sent',
    scanCursor: (row.scan_cursor as Record<string, number>) ?? {},
    imapHost: (row.imap_host as string) ?? null,
    imapPort: row.imap_port != null ? Number(row.imap_port) : null,
    imapUseTls: Boolean(row.imap_use_tls ?? true),
    imapUsername: (row.imap_username as string) ?? null,
    imapPasswordEnc: (row.imap_password_enc as string) ?? null,
    oauthRefreshTokenEnc: (row.oauth_refresh_token_enc as string) ?? null,
  };
}

export async function listActiveSentConnections(): Promise<SentMirrorConnection[]> {
  const rows = (await sql`
    SELECT * FROM sent_mirror_connections
    WHERE status = 'active'
      AND (last_scan_at IS NULL
           OR last_scan_at < NOW() - (scan_interval_minutes || ' minutes')::INTERVAL)
    ORDER BY COALESCE(last_scan_at, '1970-01-01'::timestamptz) ASC
    LIMIT 20
  `) as Row[];
  return rows.map(loadConnection);
}

export async function listSentConnectionsForCompany(companyId: string): Promise<SentMirrorConnection[]> {
  const rows = (await sql`
    SELECT * FROM sent_mirror_connections
    WHERE company_id = ${companyId}::uuid
    ORDER BY created_at DESC
  `) as Row[];
  return rows.map(loadConnection);
}

export async function getSentConnection(id: string, companyId: string): Promise<SentMirrorConnection | null> {
  const rows = (await sql`
    SELECT * FROM sent_mirror_connections
    WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid
    LIMIT 1
  `) as Row[];
  return rows.length ? loadConnection(rows[0]!) : null;
}

// ─── Attachment handling ──────────────────────────────────────────────────────

function looksCapturable(att: Attachment): boolean {
  const mime = (att.contentType ?? '').toLowerCase();
  if (!ATTACHMENT_MIME_ALLOW.has(mime)) return false;
  if ((att.size ?? 0) === 0) return false;
  return true;
}

interface LinkMatch {
  documentId: string;
  invoiceId: string | null;
  documentType: string | null;
}

/**
 * Look up an existing captured_documents row for this tenant by raw byte
 * hash. Returns the document id + any customer_invoice that already points
 * at it (the snapshot link from Phase 1).
 *
 * Company-scoped so a sha collision across tenants still creates a new row.
 */
async function findExistingByHash(
  companyId: string,
  hash: string,
): Promise<LinkMatch | null> {
  const rows = (await sql`
    SELECT cd.id AS document_id,
           cd.document_type,
           ci.id AS invoice_id
    FROM captured_documents cd
    LEFT JOIN customer_invoices ci
      ON ci.source_document_id = cd.id
     AND ci.company_id = cd.company_id
    WHERE cd.company_id = ${companyId}::uuid
      AND cd.raw_bytes_sha256 = ${hash}
    ORDER BY cd.created_at ASC
    LIMIT 1
  `) as Row[];
  const row = rows[0];
  if (!row) return null;
  return {
    documentId: String(row.document_id),
    invoiceId: row.invoice_id ? String(row.invoice_id) : null,
    documentType: row.document_type ? String(row.document_type) : null,
  };
}

async function captureOutbound(
  conn: SentMirrorConnection,
  parsed: ParsedMail,
  att: Attachment,
  hash: string,
): Promise<string> {
  const content = att.content as Buffer;
  const mime = (att.contentType ?? 'application/octet-stream').toLowerCase();
  const filename = att.filename ?? `sent-${hash.slice(0, 8)}`;
  const recipient = parsed.to
    ? Array.isArray(parsed.to) ? parsed.to[0]?.text ?? null : parsed.to.text ?? null
    : null;
  const subject = parsed.subject ?? null;

  const [doc] = (await sql`
    INSERT INTO captured_documents (
      company_id, file_name, file_type, file_size,
      document_type, status,
      raw_bytes_sha256, raw_bytes_size,
      notes
    ) VALUES (
      ${conn.companyId}::uuid, ${filename}, ${mime}, ${content.length},
      'outbound_email', 'matched',
      ${hash}, ${content.length},
      ${`Sent-mirror capture · to=${recipient ?? '?'} · subject=${subject ?? '(none)'}`}
    )
    RETURNING id
  `) as Row[];

  const documentId = String(doc!.id);
  const stored = await storeCapturedBytes(conn.companyId, documentId, content, mime);
  await sql`
    UPDATE captured_documents
    SET storage_bucket = ${stored.bucket}, storage_path = ${stored.path}
    WHERE id = ${documentId}::uuid
      AND company_id = ${conn.companyId}::uuid
  `;

  return documentId;
}

// ─── Logging + cursor ─────────────────────────────────────────────────────────

interface ScanLogEntry {
  imapUid: string | null;
  recipient: string | null;
  subject: string | null;
  attachmentCount: number;
  outcome: 'linked_to_invoice' | 'captured_outbound' | 'skipped_no_attachment' | 'error';
  error?: string | null;
  linkedInvoiceIds?: string[];
  capturedDocumentIds?: string[];
}

async function logScanEntry(conn: SentMirrorConnection, entry: ScanLogEntry): Promise<void> {
  await sql`
    INSERT INTO sent_mirror_scan_log
      (connection_id, company_id, imap_uid, recipient, subject,
       attachment_count, outcome, error,
       linked_invoice_ids, captured_document_ids)
    VALUES
      (${conn.id}::uuid, ${conn.companyId}::uuid, ${entry.imapUid},
       ${entry.recipient}, ${entry.subject}, ${entry.attachmentCount},
       ${entry.outcome}, ${entry.error ?? null},
       ${entry.linkedInvoiceIds ?? null}::uuid[],
       ${entry.capturedDocumentIds ?? null}::uuid[])
  `;
}

async function advanceCursor(conn: SentMirrorConnection, folder: string, uid: number): Promise<void> {
  const nextCursor = { ...conn.scanCursor, [folder]: uid };
  await sql`
    UPDATE sent_mirror_connections
    SET scan_cursor = ${JSON.stringify(nextCursor)}::jsonb,
        last_scan_at = NOW(),
        last_success_at = NOW()
    WHERE id = ${conn.id}::uuid
  `;
}

async function markScanError(conn: SentMirrorConnection, error: string): Promise<void> {
  await sql`
    UPDATE sent_mirror_connections
    SET last_scan_at = NOW(),
        last_error = ${error},
        status = CASE WHEN status = 'active' THEN 'error' ELSE status END
    WHERE id = ${conn.id}::uuid
  `;
}

// ─── IMAP connection ──────────────────────────────────────────────────────────

async function openImapClient(conn: SentMirrorConnection): Promise<ImapFlow> {
  if (conn.provider !== 'imap') {
    throw new Error(`${conn.provider} OAuth flow not yet wired — pending Google/Microsoft app registration`);
  }
  if (!conn.imapHost || !conn.imapPort || !conn.imapUsername || !conn.imapPasswordEnc) {
    throw new Error(`Incomplete IMAP config for sent-mirror connection ${conn.id}`);
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

// ─── Scan ─────────────────────────────────────────────────────────────────────

export async function scanSentConnection(conn: SentMirrorConnection): Promise<SentMirrorScanResult> {
  const result: SentMirrorScanResult = {
    connectionId: conn.id,
    scanned: 0,
    linked: 0,
    captured: 0,
    skipped: 0,
    errors: 0,
  };

  let client: ImapFlow | null = null;
  try {
    client = await openImapClient(conn);
    await client.connect();

    const lock = await client.getMailboxLock(conn.sentFolder);
    try {
      const cursorUid = Number(conn.scanCursor[conn.sentFolder] ?? 0);
      const searchRange = cursorUid > 0 ? `${cursorUid + 1}:*` : '1:*';

      const metas: FetchMessageObject[] = [];
      for await (const meta of client.fetch(searchRange, { uid: true, envelope: true, size: true })) {
        metas.push(meta);
        if (metas.length >= 50) break;
      }

      let maxUidSeen = cursorUid;

      for (const meta of metas) {
        result.scanned += 1;
        const uid = Number(meta.uid);
        if (uid > maxUidSeen) maxUidSeen = uid;

        const recipientEntry = meta.envelope?.to?.[0];
        const recipient = recipientEntry ? `${recipientEntry.address}` : null;
        const subject = meta.envelope?.subject ?? null;

        const full = await client.fetchOne(String(uid), { source: true, uid: true });
        if (!full || !full.source) {
          result.skipped += 1;
          continue;
        }

        const parsed = await simpleParser(full.source);
        const attachments = (parsed.attachments ?? []).filter(looksCapturable);

        if (attachments.length === 0) {
          result.skipped += 1;
          await logScanEntry(conn, {
            imapUid: String(uid), recipient, subject,
            attachmentCount: 0, outcome: 'skipped_no_attachment',
          });
          continue;
        }

        const linkedInvoiceIds: string[] = [];
        const capturedDocumentIds: string[] = [];

        try {
          for (const att of attachments) {
            const hash = sha256(att.content as Buffer);
            const existing = await findExistingByHash(conn.companyId, hash);
            if (existing) {
              if (existing.invoiceId) linkedInvoiceIds.push(existing.invoiceId);
              result.linked += 1;
            } else {
              const documentId = await captureOutbound(conn, parsed, att, hash);
              capturedDocumentIds.push(documentId);
              result.captured += 1;
            }
          }

          const outcome: ScanLogEntry['outcome'] =
            capturedDocumentIds.length > 0 ? 'captured_outbound' : 'linked_to_invoice';

          await logScanEntry(conn, {
            imapUid: String(uid), recipient, subject,
            attachmentCount: attachments.length,
            outcome,
            linkedInvoiceIds: linkedInvoiceIds.length ? linkedInvoiceIds : undefined,
            capturedDocumentIds: capturedDocumentIds.length ? capturedDocumentIds : undefined,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          result.errors += 1;
          log.warn('sent mirror ingest failed', { connectionId: conn.id, uid, err: msg }, 'sent-mirror');
          await logScanEntry(conn, {
            imapUid: String(uid), recipient, subject,
            attachmentCount: attachments.length,
            outcome: 'error', error: msg,
          });
        }
      }

      if (maxUidSeen > cursorUid) {
        await advanceCursor(conn, conn.sentFolder, maxUidSeen);
      } else {
        await sql`
          UPDATE sent_mirror_connections
          SET last_scan_at = NOW(), last_success_at = NOW()
          WHERE id = ${conn.id}::uuid
        `;
      }

      if (result.captured > 0 || result.linked > 0) {
        await sql`
          UPDATE sent_mirror_connections
          SET messages_captured_total = messages_captured_total + ${result.captured},
              messages_linked_total   = messages_linked_total   + ${result.linked}
          WHERE id = ${conn.id}::uuid
        `;
      }
    } finally {
      lock.release();
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('sent mirror scan failed', { connectionId: conn.id, err: msg }, 'sent-mirror');
    result.errors += 1;
    await markScanError(conn, msg);
  } finally {
    if (client) {
      try { await client.logout(); } catch { /* ignore */ }
    }
  }

  return result;
}

export async function scanAllDueSentConnections(): Promise<SentMirrorScanResult[]> {
  const connections = await listActiveSentConnections();
  const results: SentMirrorScanResult[] = [];
  for (const conn of connections) {
    results.push(await scanSentConnection(conn));
  }
  return results;
}
