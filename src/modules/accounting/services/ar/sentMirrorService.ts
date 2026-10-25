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
 *
 * No app role writes sent_mirror_connections (S-07e part B, migration 946): the
 * scan's stamps and the due selection are sentMirrorWrites.ts's, the flip of
 * `status` to 'error' capture/mirrorScanError.ts's, all on migration_admin.
 */

import type { ImapFlow } from 'imapflow';
import { simpleParser, type ParsedMail, type Attachment } from 'mailparser';

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { decrypt } from '@/lib/encryption';
import { sha256, storeCapturedBytes } from '@/lib/documentStorage';
import { markMirrorScanError } from '@/modules/accounting/services/capture/mirrorScanError';
import { readCursor } from '@/modules/accounting/services/capture/mirrorCursor';
import { createMirrorClient } from '@/modules/accounting/services/capture/mirrorImapClient';
import { clipMirrorText, isOversizedMessage, runGuardedScan, type ScanGuard, type ScanOptions } from '@/modules/accounting/services/capture/mirrorScanGuard';
import { findExistingByHash } from '@/modules/accounting/services/capture/capturedDocumentHash';
import { fetchNewMessages, fetchSourceByUid, mailboxUidNext } from '@/modules/accounting/services/capture/mirrorImapFetch';
import { isScanLockSkip } from '@/modules/accounting/services/capture/mirrorScanWrite';
import { addCounters, advanceCursor, logScanEntry, selectDueSentConnections, stampSuccess, type ScanLogEntry } from './sentMirrorWrites';
import { checkImapTarget } from '@/lib/imapTargetGuard';

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
  return (await selectDueSentConnections()).map(loadConnection);
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

async function captureOutbound(
  conn: SentMirrorConnection,
  parsed: ParsedMail,
  att: Attachment,
  hash: string,
): Promise<string> {
  const content = att.content as Buffer;
  const mime = (att.contentType ?? 'application/octet-stream').toLowerCase();
  const filename = att.filename ?? `sent-${hash.slice(0, 8)}`;
  const recipient = clipMirrorText(parsed.to ? Array.isArray(parsed.to) ? parsed.to[0]?.text : parsed.to.text : null);
  const subject = clipMirrorText(parsed.subject);

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

// ─── IMAP connection ──────────────────────────────────────────────────────────

async function openImapClient(conn: SentMirrorConnection): Promise<ImapFlow> {
  if (conn.provider !== 'imap') {
    throw new Error(`${conn.provider} OAuth flow not yet wired — pending Google/Microsoft app registration`);
  }
  if (!conn.imapHost || !conn.imapPort || !conn.imapUsername || !conn.imapPasswordEnc) {
    throw new Error(`Incomplete IMAP config for sent-mirror connection ${conn.id}`);
  }
  // Before the password is decrypted: never connect to private space. Connect to the vetted address, not the name.
  const target = await checkImapTarget(conn.imapHost, conn.imapPort);
  if (!target.ok) throw new Error(target.message);
  const password = decrypt(conn.imapPasswordEnc);
  return createMirrorClient({
    host: target.address, servername: target.servername, port: conn.imapPort, secure: conn.imapUseTls,
    user: conn.imapUsername, pass: password,
  });
}

// ─── Scan ─────────────────────────────────────────────────────────────────────

/** Scans one connection under the per-scan deadline (mirrorScanGuard.ts); a scan that overruns is closed, stamped and abandoned. */
export function scanSentConnection(conn: SentMirrorConnection, opts: ScanOptions = {}): Promise<SentMirrorScanResult> {
  const result: SentMirrorScanResult = { connectionId: conn.id, scanned: 0, linked: 0, captured: 0, skipped: 0, errors: 0 };
  return runGuardedScan('sent', conn, result, (guard) => scanBody(conn, result, guard), opts.deadlineMs);
}

async function scanBody(conn: SentMirrorConnection, result: SentMirrorScanResult, guard: ScanGuard): Promise<SentMirrorScanResult> {
  let client: ImapFlow | null = null;
  try {
    client = guard.track(await openImapClient(conn));
    await client.connect();

    const lock = await client.getMailboxLock(conn.sentFolder);
    try {
      const uidNext = mailboxUidNext(client);
      const { uid: cursorUid, clamped } = readCursor(conn.scanCursor, conn.sentFolder, { id: conn.id, kind: 'sent-mirror' }, uidNext);
      // Clean exit when the mailbox has nothing past the cursor — IMAP
      // "fetch 2:*" on an empty/stale range throws "Command failed" on some
      // servers (cPanel/dovecot). Guard with mailbox.uidNext.
      if (uidNext > 0 && cursorUid + 1 >= uidNext) {
        if (clamped) await advanceCursor(conn, conn.sentFolder, cursorUid); // store the clamped cursor, or new mail stays behind the forged one
        else await stampSuccess(conn); // no new messages
        return result;
      }

      const metas = await fetchNewMessages(client, cursorUid);

      let maxUidSeen = cursorUid;
      for (const meta of metas) {
        guard.check();
        result.scanned += 1;
        const uid = Number(meta.uid);
        if (uid > maxUidSeen) maxUidSeen = uid;

        const recipientEntry = meta.envelope?.to?.[0];
        const recipient = recipientEntry ? `${recipientEntry.address}` : null;
        const subject = meta.envelope?.subject ?? null;

        if (isOversizedMessage(meta.size)) {
          result.skipped += 1;
          log.warn('sent mirror message too large to fetch; skipped', { connectionId: conn.id, uid, size: meta.size }, 'sent-mirror');
          await logScanEntry(conn, { imapUid: String(uid), recipient, subject, attachmentCount: 0, outcome: 'skipped_too_large' });
          continue;
        }

        const source = await fetchSourceByUid(client, uid);
        if (!source) {
          result.skipped += 1;
          continue;
        }

        const parsed = await simpleParser(source);
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
            guard.check(); // an abandoned scan ingests nothing more
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
          if (guard.expired || isScanLockSkip(err)) throw err;
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

      guard.check();
      if (maxUidSeen > cursorUid || clamped) await advanceCursor(conn, conn.sentFolder, maxUidSeen);
      else await stampSuccess(conn);
      if (result.captured > 0 || result.linked > 0) await addCounters(conn, result.captured, result.linked);
    } finally {
      lock.release();
    }
  } catch (err) {
    if (guard.expired) return result; // the deadline's owner has stamped the row
    if (isScanLockSkip(err)) {
      log.warn('sent mirror scan skipped this tick: the connection row is locked', { connectionId: conn.id }, 'sent-mirror');
      return result;
    }
    const msg = err instanceof Error ? err.message : String(err);
    log.error('sent mirror scan failed', { connectionId: conn.id, err: msg }, 'sent-mirror');
    result.errors += 1;
    await markMirrorScanError('sent', conn, msg);
  } finally {
    if (client && !guard.expired) {
      try { await client.logout(); } catch (err) {
        log.debug('sent mirror client logout failed', { connectionId: conn.id, err: String((err as Error)?.message ?? err) }, 'sent-mirror');
      }
    }
  }

  return result;
}

export async function scanAllDueSentConnections(opts: ScanOptions = {}): Promise<SentMirrorScanResult[]> {
  const connections = await listActiveSentConnections();
  const results: SentMirrorScanResult[] = [];
  for (const conn of connections) {
    results.push(await scanSentConnection(conn, opts));
  }
  return results;
}
