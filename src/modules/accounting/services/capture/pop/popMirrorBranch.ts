/**
 * The IMAP mirror's branch for ABSA "Notice of payment" mail (POP inbox, phase 1).
 *
 * imapMirrorService lets a message through its invoice-subject filter when its envelope looks
 * like an ABSA notice (isAbsaNoticeEnvelope), then hands its attachments here instead of to the
 * bill capture ingest. Only a message whose DKIM signature verifies as ABSA's (absaPopTrust.ts),
 * from a trusted payer, with a PDF that reads as a complete notice, is filed. Anything else is
 * NOT captured (a payment notice read as a supplier bill is worse than none) but logged: its
 * reasons go to the scan log as outcome 'pop_not_filed'. A lookup of ABSA's key that failed for
 * want of DNS is transient for DNS_RETRY_MS after the server received the message (IMAP
 * INTERNALDATE, not sender-set): the scan stops at it and retries next tick. After that, or with
 * no receive time, it is logged as not filed so one message cannot hold the mailbox.
 */
import type { Attachment } from 'mailparser';
import { log } from '@/lib/logger';
import { ABSA_NOTICE_SENDER, isTrustedAbsaNotice } from './absaPopTrust';
import { ingestAbsaPop, isPdfBytes } from './popIngest';
import { isTransientIngestError, TransientIngestError } from '../imapMirrorInbox';

export function isAbsaNoticeEnvelope(fromAddress: string, subject: string | null | undefined): boolean {
  return fromAddress.trim().toLowerCase() === ABSA_NOTICE_SENDER && /notice of payment/i.test(subject ?? '');
}

/** ABSA labels some notices `*\/*`; a PDF by its bytes is still a notice attachment. */
export function isNoticeAttachment(att: Attachment): boolean {
  return Buffer.isBuffer(att.content) && isPdfBytes(att.content);
}

/** How long after receipt a DNS failure on ABSA's key holds the mailbox for a retry. */
export const DNS_RETRY_MS = 24 * 60 * 60 * 1000;

export interface NoticeFiling {
  /** proof_of_payments ids filed from this message. */
  popIds: string[];
  /** Why each attachment that is neither filed nor already held was not filed. */
  notFiled: string[];
}

export async function fileAbsaNotice(
  companyId: string,
  source: Buffer,
  attachments: Attachment[],
  check: () => void,
  receivedAt: Date | string | undefined,
  now: number = Date.now(),
): Promise<NoticeFiling> {
  const trust = await isTrustedAbsaNotice(source);
  if (!trust.trusted) {
    const received = receivedAt === undefined ? NaN : new Date(receivedAt).getTime();
    const age = Number.isNaN(received) ? Infinity : now - received;
    if (trust.reason === 'dns_unavailable' && age < DNS_RETRY_MS) {
      throw new TransientIngestError('ABSA DKIM key lookup failed (DNS); retried next scan');
    }
    log.warn('ABSA-looking notice failed verification; not filed', { companyId, reason: trust.reason }, 'pop-inbox');
    return { popIds: [], notFiled: attachments.map(() => trust.reason) };
  }

  const out: NoticeFiling = { popIds: [], notFiled: [] };
  for (const att of attachments) {
    check(); // an abandoned scan files nothing more
    try {
      const r = await ingestAbsaPop(companyId, att);
      if (r.filed) out.popIds.push(r.popId);
      else if (r.reason !== 'duplicate') out.notFiled.push(r.reason);
    } catch (err) {
      if (isTransientIngestError(err)) throw err; // the scan stops here and retries the message
      const code = (err as { code?: unknown } | null)?.code;
      log.warn('ABSA notice PDF failed to file', { companyId, code, err: err instanceof Error ? err.message : String(err) }, 'pop-inbox');
      out.notFiled.push(`error${typeof code === 'string' ? ` ${code}` : ''}`);
    }
  }
  if (out.notFiled.length) log.warn('ABSA notice PDF(s) not filed', { companyId, reasons: out.notFiled }, 'pop-inbox');
  return out;
}
