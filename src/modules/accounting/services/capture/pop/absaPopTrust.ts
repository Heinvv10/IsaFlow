/**
 * Whether a raw message is a genuine ABSA payment notice: sent from ibreply@absa.co.za and
 * carrying a DKIM signature by absa.co.za that verifies over the whole message body.
 *
 * Why DKIM is checked here and not read from a header: the mailbox host adds no
 * Authentication-Results, and the X-DKIM line it does add sits in the message where a sender
 * could have written one too. A signature checked against ABSA's published key cannot be
 * forged by a sender. Only a trusted notice is filed without a person looking at it, so
 * every doubt (no key, DNS failure, partial-body l= signature, two From addresses) refuses.
 *
 * Runtime note: mailauth's verifier works under Node (production, vitest). Under Bun it
 * reports every signature "neutral (unknown key type)", so a Bun script would refuse all.
 */
import { dkimVerify } from 'mailauth';
import { log } from '@/lib/logger';

export const ABSA_NOTICE_SENDER = 'ibreply@absa.co.za';
const ABSA_SIGNING_DOMAIN = 'absa.co.za';

export type TrustResult =
  | { trusted: true }
  | { trusted: false; reason: 'not_absa_notice_sender' | 'no_absa_signature' };

export interface TrustOptions {
  /** DNS TXT resolver (tests); defaults to the system resolver. */
  resolver?: (name: string, rr: string) => Promise<string[][]>;
}

interface DkimResultLike {
  signingDomain?: string;
  status?: { result?: string; underSized?: number };
}

export async function isTrustedAbsaNotice(raw: Buffer, opts: TrustOptions = {}): Promise<TrustResult> {
  let verified: { headerFrom?: string[]; results?: DkimResultLike[] };
  try {
    verified = await dkimVerify(raw, opts.resolver ? { resolver: opts.resolver } : {});
  } catch (err) {
    log.warn('POP notice DKIM verification failed to run', { err: err instanceof Error ? err.message : String(err) }, 'pop-inbox');
    return { trusted: false, reason: 'no_absa_signature' };
  }

  const from = (verified.headerFrom ?? []).map((a) => a.trim().toLowerCase());
  if (from.length !== 1 || from[0] !== ABSA_NOTICE_SENDER) return { trusted: false, reason: 'not_absa_notice_sender' };

  const signed = (verified.results ?? []).some((r) =>
    r.status?.result === 'pass'
    && r.signingDomain?.toLowerCase() === ABSA_SIGNING_DOMAIN
    && !r.status.underSized);
  return signed ? { trusted: true } : { trusted: false, reason: 'no_absa_signature' };
}
