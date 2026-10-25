/**
 * The capture mirror's mailbox login (S-07e part B): the stored target is vetted
 * (imapTargetGuard) before the password is decrypted, and the client connects to the
 * vetted address, not the name.
 */
import type { ImapFlow } from 'imapflow';
import { checkImapTarget } from '@/lib/imapTargetGuard';
import { decrypt } from '@/lib/encryption';
import { createMirrorClient } from './mirrorImapClient';
import type { MirrorConnection } from './imapMirrorService';

export async function openImapClient(conn: MirrorConnection): Promise<ImapFlow> {
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
