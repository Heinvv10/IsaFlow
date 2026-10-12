/**
 * Telling the person that the VAT on what they just posted was claimed LATE
 * (VAT Act s16(3), gl/vatLateClaimSplit): the document is dated in a filed VAT
 * period, so its input VAT lands in the next open one. Every route that can do
 * this returns `lateClaim` (bank allocation, bill approve / Post to GL, journal
 * post, expense claim); every screen that calls one passes the response here.
 *
 * One channel (the toast), so the notice reads the same wherever it appears.
 */
import { notify } from '@/utils/toast';
import { NOTICE_LINE_FITS } from '@/components/accounting/postingWarningsNotice';

export interface LateClaimNotice {
  claimDate: string;
  lockPeriod: { start: string; end: string };
  inputTax: number;
}

function isLateClaim(v: unknown): v is LateClaimNotice {
  const o = v as Partial<LateClaimNotice> | null;
  return !!o && typeof o.claimDate === 'string' && typeof o.inputTax === 'number'
    && !!o.lockPeriod && typeof o.lockPeriod.start === 'string';
}

/**
 * The toast clips its second line to one row (~45 characters), so the FACT —
 * how much VAT, claimed late, from when — is the TITLE, which wraps (the same
 * as postingWarningsNotice); the second line holds only what fits.
 */
export function lateClaimNotice(found: readonly LateClaimNotice[]): { title: string; message: string } {
  const first = found[0]!;
  if (found.length === 1) {
    const period = `Period ${first.lockPeriod.start} to ${first.lockPeriod.end} is filed.`;
    return {
      title: `Input VAT of R${first.inputTax.toFixed(2)} claimed late, from ${first.claimDate}`,
      message: period.length <= NOTICE_LINE_FITS ? period : 'Its VAT period is filed.',
    };
  }
  const total = found.reduce((s, l) => s + l.inputTax, 0);
  return {
    title: `${found.length} documents' input VAT of R${total.toFixed(2)} claimed late, from ${first.claimDate}`,
    message: 'Their VAT periods are filed.',
  };
}

/**
 * Every late claim in an API response body: `data.lateClaim`, `data.claim.lateClaim`
 * (expense claims) or `data.results[].lateClaim` (bulk actions).
 */
export function lateClaimsIn(body: unknown): LateClaimNotice[] {
  const data = (body as { data?: Record<string, unknown> } | null)?.data;
  if (!data) return [];
  const results = Array.isArray(data.results) ? data.results as Record<string, unknown>[] : [];
  return [
    data.lateClaim,
    (data.claim as Record<string, unknown> | undefined)?.lateClaim,
    ...results.map((r) => r?.lateClaim),
  ].filter(isLateClaim);
}

/** Show the notice for a response, if it carries a late claim. Returns how many it found. */
export function notifyLateClaims(body: unknown): number {
  const found = lateClaimsIn(body);
  if (found.length > 0) {
    const { title, message } = lateClaimNotice(found);
    notify.info(title, message);
  }
  return found.length;
}
