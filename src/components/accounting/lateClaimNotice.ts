/**
 * Telling the person that the VAT on what they just posted was claimed LATE
 * (VAT Act s16(3), gl/vatLateClaimSplit): the document is dated in a filed VAT
 * period, so its input VAT lands in the next open one. Every route that can do
 * this returns `lateClaim` (bank allocation, bill approve / Post to GL, journal
 * post, expense claim); every screen that calls one passes the response here.
 *
 * One sentence, one channel (the toast), so the notice reads the same wherever
 * it appears.
 */
import { notify } from '@/utils/toast';

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

export function lateClaimMessage(lc: LateClaimNotice): string {
  return `Input VAT of R${lc.inputTax.toFixed(2)} was claimed late, in the VAT period starting ${lc.claimDate} `
    + `(the period ${lc.lockPeriod.start} to ${lc.lockPeriod.end} is filed).`;
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
  if (found.length === 1) notify.info('VAT claimed in a later period', lateClaimMessage(found[0]!));
  else if (found.length > 1) {
    const total = found.reduce((s, l) => s + l.inputTax, 0);
    notify.info(
      `${found.length} documents' VAT claimed in a later period`,
      `Input VAT of R${total.toFixed(2)} was claimed late, from ${found[0]!.claimDate}: their VAT periods are filed.`,
    );
  }
  return found.length;
}
