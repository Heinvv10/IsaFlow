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
 *
 * App-pool writes to imap_mirror_connections are the scan stamps only, each
 * keyed on the connection AND its company (S-07e part B, migration 946). The
 * flip of `status` to 'error' is mirrorScanError.ts's, on migration_admin.
 */

import type { ImapFlow } from 'imapflow';
import { simpleParser, type Attachment } from 'mailparser';
import { sql } from '@/lib/neon';
import { ensureMirrorInbox, isTransientIngestError } from './imapMirrorInbox';
import { markMirrorScanError } from './mirrorScanError';
import { readCursor } from './mirrorCursor';
import { createMirrorClient } from './mirrorImapClient';
import { isOversizedMessage, runGuardedScan, type ScanGuard, type ScanOptions } from './mirrorScanGuard';
import { ingestAttachment } from './imapMirrorIngest';
import { fetchNewMessages, fetchSourceByUid, mailboxUidNext } from './mirrorImapFetch';
import { isScanLockSkip } from './mirrorScanWrite';
import { addIngested, logScanEntry, stampStopped, stampSuccess, updateCursor } from './imapMirrorWrites';
import { checkImapTarget } from '@/lib/imapTargetGuard';
import { log } from '@/lib/logger';
import { decrypt } from '@/lib/encryption';

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
           OR last_scan_at > NOW()
           OR last_scan_at < NOW() - (scan_interval_minutes || ' minutes')::INTERVAL)
    ORDER BY CASE WHEN last_scan_at > NOW() THEN 'infinity'::timestamptz ELSE last_scan_at END ASC NULLS FIRST
    LIMIT 20
    FOR UPDATE SKIP LOCKED
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
    // Before the password is decrypted: never connect to private space. Connect to the vetted address, not the name.
    const target = await checkImapTarget(conn.imapHost, conn.imapPort);
    if (!target.ok) throw new Error(target.message);
    const password = decrypt(conn.imapPasswordEnc);
    return createMirrorClient({
      host: target.address, servername: target.servername, port: conn.imapPort, secure: conn.imapUseTls,
      user: conn.imapUsername, pass: password,
    });
  }
  // Gmail / M365 use OAuth2 — actual token exchange handled by the provider-
  // specific service modules. For now, refuse to scan until those ship.
  throw new Error(`${conn.provider} OAuth flow not yet wired — pending Google/Microsoft app registration`);
}

// ─── Scanning ─────────────────────────────────────────────────────────────────

/** Scans one connection under the per-scan deadline (mirrorScanGuard.ts); a scan that overruns is closed, stamped and abandoned. */
export function scanConnection(conn: MirrorConnection, opts: ScanOptions = {}): Promise<ScanResult> {
  const result: ScanResult = { connectionId: conn.id, scanned: 0, ingested: 0, skipped: 0, errors: 0 };
  return runGuardedScan('imap', conn, result, (guard) => scanBody(conn, result, guard), opts.deadlineMs);
}

async function scanBody(conn: MirrorConnection, result: ScanResult, guard: ScanGuard): Promise<ScanResult> {
  let client: ImapFlow | null = null;
  try {
    client = guard.track(await openImapClient(conn));
    await client.connect();

    const lock = await client.getMailboxLock(conn.folder);
    try {
      const { uid: cursorUid, clamped } = readCursor(conn.scanCursor, conn.folder, { id: conn.id, kind: 'imap-mirror' }, mailboxUidNext(client));

      // Fetch UIDs + minimal metadata first — don't pull bodies we don't want
      const msgs = await fetchNewMessages(client, cursorUid);

      let maxUidSeen = cursorUid;
      let stoppedOn: string | null = null;

      for (const meta of msgs) {
        guard.check();
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

        if (isOversizedMessage(meta.size)) {
          result.skipped += 1;
          log.warn('mirror message too large to fetch; skipped', { connectionId: conn.id, uid, size: meta.size }, 'imap-mirror');
          await logScanEntry(conn, { imapUid: String(uid), sender: fromAddr,
            subject, attachmentCount: 0, outcome: 'skipped_too_large' });
          continue;
        }

        // Pull the full message body now that the metadata filters pass
        const source = await fetchSourceByUid(client, uid);
        if (!source) {
          result.skipped += 1;
          continue;
        }

        const parsed = await simpleParser(source);
        const attachments = (parsed.attachments ?? []).filter(looksLikeInvoiceAttachment);

        if (attachments.length === 0) {
          result.skipped += 1;
          await logScanEntry(conn, { imapUid: String(uid), sender: fromAddr,
            subject, attachmentCount: 0, outcome: 'skipped_no_attachment' });
          continue;
        }

        const eventIds: string[] = [];
        try {
          // Once per message, before any attachment: a failure here leaves nothing half-ingested.
          const inboxId = await ensureMirrorInbox(conn.companyId, conn.accountEmail);
          for (const att of attachments) {
            const eventId = await ingestAttachment(conn, inboxId, parsed, att);
            if (eventId) eventIds.push(eventId); // null: the tenant already holds this file
          }
          result.ingested += eventIds.length;
          if (eventIds.length === 0) result.skipped += 1;
          await logScanEntry(conn, { imapUid: String(uid), sender: fromAddr,
            subject, attachmentCount: attachments.length,
            outcome: eventIds.length > 0 ? 'ingested' : 'skipped_duplicate', captureEventIds: eventIds });
        } catch (ingestErr) {
          if (isScanLockSkip(ingestErr)) throw ingestErr;
          const msg = ingestErr instanceof Error ? ingestErr.message : String(ingestErr);
          result.errors += 1;
          log.warn('mirror ingest failed', { connectionId: conn.id, uid, err: msg }, 'imap-mirror');
          await logScanEntry(conn, { imapUid: String(uid), sender: fromAddr,
            subject, attachmentCount: attachments.length,
            outcome: 'error', error: msg });
          // Database-side, nothing of it ingested: stop, cursor before it, so the next scan retries it.
          if (isTransientIngestError(ingestErr) && eventIds.length === 0) { stoppedOn = msg; maxUidSeen = uid - 1; break; }
        }
      }

      guard.check();
      if (maxUidSeen > cursorUid || clamped) {
        await updateCursor(conn, conn.folder, maxUidSeen);
      } else if (!stoppedOn) {
        await stampSuccess(conn);
      }
      if (stoppedOn) await stampStopped(conn, stoppedOn);
      if (result.ingested > 0) await addIngested(conn, result.ingested);
    } finally {
      lock.release();
    }
  } catch (err) {
    if (guard.expired) return result; // the deadline's owner has stamped the row
    if (isScanLockSkip(err)) {
      log.warn('mirror scan skipped this tick: the connection row is locked', { connectionId: conn.id }, 'imap-mirror');
      return result;
    }
    const msg = err instanceof Error ? err.message : String(err);
    log.error('mirror scan failed', { connectionId: conn.id, err: msg }, 'imap-mirror');
    result.errors += 1;
    await markMirrorScanError('imap', conn, msg);
  } finally {
    if (client && !guard.expired) {
      try { await client.logout(); } catch (err) {
        log.debug('mirror client logout failed', { connectionId: conn.id, err: String((err as Error)?.message ?? err) }, 'imap-mirror');
      }
    }
  }

  return result;
}

export async function scanAllDueConnections(opts: ScanOptions = {}): Promise<ScanResult[]> {
  const connections = await listActiveConnections();
  const results: ScanResult[] = [];
  for (const conn of connections) {
    results.push(await scanConnection(conn, opts));
  }
  return results;
}
