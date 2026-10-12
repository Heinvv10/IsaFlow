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
import { NOTICE_LINE_FITS, listNames } from '@/components/accounting/noticeLine';

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
 * how much VAT, claimed late, in which VAT period — is the TITLE, which wraps
 * (the same as postingWarningsNotice); the second line holds only what fits:
 * the filed period for one claim, the bills' numbers (`names`, one per claim,
 * when the response carried them) for several.
 */
export function lateClaimNotice(
  found: readonly LateClaimNotice[], names: ReadonlyArray<string | undefined> = [],
): { title: string; message: string } {
  const first = found[0]!;
  if (found.length === 1) {
    const period = `Period ${first.lockPeriod.start} to ${first.lockPeriod.end} is filed.`;
    return {
      title: `Input VAT of R${first.inputTax.toFixed(2)} claimed late, in the VAT period from ${first.claimDate}`,
      message: period.length <= NOTICE_LINE_FITS ? period : 'Its VAT period is filed.',
    };
  }
  const total = found.reduce((s, l) => s + l.inputTax, 0);
  const earliest = found.map((l) => l.claimDate).reduce((a, b) => (b < a ? b : a));
  return {
    title: `${found.length} documents' input VAT of R${total.toFixed(2)} claimed late, in the VAT period from ${earliest}`,
    message: listNames('Bills: ', found.map((_, i) => names[i]), 'Their VAT periods are filed.'),
  };
}

/** A late claim and the number of the bill it was on, when the response carries one (bulk actions). */
export interface LateClaimDocument { claim: LateClaimNotice; name?: string }

/**
 * Every late claim in an API response body: `data.lateClaim`, `data.claim.lateClaim`
 * (expense claims) or `data.results[].lateClaim` (bulk actions, with `invoiceNumber`).
 */
export function lateClaimDocuments(body: unknown): LateClaimDocument[] {
  const data = (body as { data?: Record<string, unknown> } | null)?.data;
  if (!data) return [];
  const results = Array.isArray(data.results) ? data.results as Record<string, unknown>[] : [];
  const name = (r: Record<string, unknown>) => (typeof r?.invoiceNumber === 'string' && r.invoiceNumber !== '' ? r.invoiceNumber : undefined);
  return [
    { claim: data.lateClaim },
    { claim: (data.claim as Record<string, unknown> | undefined)?.lateClaim },
    ...results.map((r) => ({ claim: r?.lateClaim, name: name(r) })),
  ].filter((d): d is LateClaimDocument => isLateClaim(d.claim));
}

/** The late claims in a response body, without the bills' numbers. */
export function lateClaimsIn(body: unknown): LateClaimNotice[] {
  return lateClaimDocuments(body).map((d) => d.claim);
}

/** Show the notice for a response, if it carries a late claim. Returns how many it found. */
export function notifyLateClaims(body: unknown): number {
  const found = lateClaimDocuments(body);
  if (found.length > 0) {
    const { title, message } = lateClaimNotice(found.map((d) => d.claim), found.map((d) => d.name));
    notify.info(title, message);
  }
  return found.length;
}
