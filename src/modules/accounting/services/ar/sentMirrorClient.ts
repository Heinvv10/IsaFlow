/**
 * The sent-folder mirror's mailbox login and its capture of an unmatched outbound
 * attachment (S-07e part B). The stored target is vetted (imapTargetGuard) before the
 * password is decrypted, and the client connects to the vetted address, not the name.
 */
import type { ImapFlow } from 'imapflow';
import type { ParsedMail, Attachment } from 'mailparser';
import { sql } from '@/lib/neon';
import { decrypt } from '@/lib/encryption';
import { storeCapturedBytes } from '@/lib/documentStorage';
import { checkImapTarget } from '@/lib/imapTargetGuard';
import { createMirrorClient } from '@/modules/accounting/services/capture/mirrorImapClient';
import { clipMirrorText } from '@/modules/accounting/services/capture/mirrorScanGuard';
import type { SentMirrorConnection } from './sentMirrorService';

type Row = Record<string, unknown>;

export async function captureOutbound(
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

export async function openImapClient(conn: SentMirrorConnection): Promise<ImapFlow> {
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
