/**
 * The IMAP mirror's branch for ABSA "Notice of payment" mail (POP inbox, phase 1).
 *
 * imapMirrorService lets a message through its invoice-subject filter when its envelope looks
 * like an ABSA notice (isAbsaNoticeEnvelope), then hands its attachments here. Only a message
 * whose DKIM signature verifies as ABSA's (absaPopTrust.ts) is filed as proofs of payment;
 * every PDF this does not file (an untrusted message, a PDF that does not read as a complete
 * notice) is returned for the normal capture ingest, where it is VLM-read and waits for a
 * person in the capture inbox. Nothing is dropped silently.
 */
import type { Attachment } from 'mailparser';
import { log } from '@/lib/logger';
import { ABSA_NOTICE_SENDER, isTrustedAbsaNotice } from './absaPopTrust';
import { ingestAbsaPop, isPdfBytes } from './popIngest';

export function isAbsaNoticeEnvelope(fromAddress: string, subject: string | null | undefined): boolean {
  return fromAddress.trim().toLowerCase() === ABSA_NOTICE_SENDER && /notice of payment/i.test(subject ?? '');
}

/** ABSA labels some notices `*\/*`; a PDF by its bytes is still a notice attachment. */
export function isNoticeAttachment(att: Attachment): boolean {
  return Buffer.isBuffer(att.content) && isPdfBytes(att.content);
}

export interface NoticeFiling {
  /** proof_of_payments ids filed from this message. */
  popIds: string[];
  /** Attachments already filed (same ABSA transaction number or same bytes). */
  duplicates: number;
  /** Attachments for the normal capture ingest, typed application/pdf. */
  toCapture: Attachment[];
}

export async function fileAbsaNotice(
  companyId: string,
  source: Buffer,
  attachments: Attachment[],
  check: () => void,
): Promise<NoticeFiling> {
  const asPdf = (att: Attachment): Attachment => ({ ...att, contentType: 'application/pdf' });
  const trust = await isTrustedAbsaNotice(source);
  if (!trust.trusted) {
    log.warn('ABSA-looking notice failed verification; sent to capture review', { companyId, reason: trust.reason }, 'pop-inbox');
    return { popIds: [], duplicates: 0, toCapture: attachments.map(asPdf) };
  }

  const out: NoticeFiling = { popIds: [], duplicates: 0, toCapture: [] };
  for (const att of attachments) {
    check(); // an abandoned scan files nothing more
    const r = await ingestAbsaPop(companyId, att);
    if (r.filed) out.popIds.push(r.popId);
    else if (r.reason === 'duplicate') out.duplicates += 1;
    else {
      log.warn('ABSA notice PDF did not read as a complete notice; sent to capture review', { companyId, reason: r.reason }, 'pop-inbox');
      out.toCapture.push(asPdf(att));
    }
  }
  return out;
}
