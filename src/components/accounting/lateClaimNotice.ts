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
import { fmtDate } from '@/lib/fmtDate';
import { NOTICE_LINE_FITS, listNames } from '@/components/accounting/noticeLine';
import { formatMoney } from '@/lib/money/formatMoney';

export interface LateClaimNotice {
  claimDate: string;
  lockPeriod: { start: string; end: string };
  inputTax: number;
}

/**
 * A date as YYYY-MM-DD: an ISO string (what the server sends: pgTypes returns DATE
 * as 'YYYY-MM-DD') is taken as written, and a Date is read with fmtDate's LOCAL
 * getters, the repo's convention for a Date built at local midnight. Any other
 * string is NOT parsed: Date.parse would pick a day by the host's zone, and a
 * wrong day in a VAT notice is worse than no notice. Null when it is neither.
 */
function isoDay(v: unknown): string | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : fmtDate(v);
  if (typeof v !== 'string') return null;
  return /^(\d{4}-\d{2}-\d{2})(?:$|T)/.exec(v)?.[1] ?? null;
}

/** The late claim in a response's `lateClaim` field, with its dates as YYYY-MM-DD, or null when it is not one. */
function readLateClaim(v: unknown): LateClaimNotice | null {
  const o = v as { claimDate?: unknown; lockPeriod?: { start?: unknown; end?: unknown }; inputTax?: unknown } | null;
  if (!o || typeof o.inputTax !== 'number' || !o.lockPeriod) return null;
  const claimDate = isoDay(o.claimDate);
  const start = isoDay(o.lockPeriod.start);
  const end = isoDay(o.lockPeriod.end);
  return claimDate && start && end ? { claimDate, lockPeriod: { start, end }, inputTax: o.inputTax } : null;
}

/**
 * The toast clips its second line to one row (~45 characters), so the FACT —
 * how much VAT, claimed late, in which VAT period — is the TITLE, which wraps
 * (the same as postingWarningsNotice); the second line holds only what fits:
 * the filed period for one claim (with its bill's number when that fits), the
 * bills' numbers (`names`, one per claim, when the response carried them) for
 * several. Dates are YYYY-MM-DD (lateClaimDocuments normalises them).
 */
export function lateClaimNotice(
  found: readonly LateClaimNotice[], names: ReadonlyArray<string | undefined> = [],
): { title: string; message: string } {
  const first = found[0]!;
  if (found.length === 1) {
    const { start, end } = first.lockPeriod;
    // A bulk run names the bill when the name still fits beside the period.
    const candidates = [names[0] ? `${names[0]}: ${start} to ${end} is filed.` : '', `Period ${start} to ${end} is filed.`]
      .filter((c) => c !== '' && c.length <= NOTICE_LINE_FITS);
    return {
      title: `Input VAT of ${formatMoney(first.inputTax)} claimed late, in the VAT period from ${first.claimDate}`,
      message: candidates[0] ?? 'Its VAT period is filed.',
    };
  }
  const total = found.reduce((s, l) => s + l.inputTax, 0);
  const earliest = found.map((l) => l.claimDate).reduce((a, b) => (b < a ? b : a));
  return {
    title: `${found.length} documents' input VAT of ${formatMoney(total)} claimed late, in the VAT period from ${earliest}`,
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
    { claim: readLateClaim(data.lateClaim) },
    { claim: readLateClaim((data.claim as Record<string, unknown> | undefined)?.lateClaim) },
    ...results.map((r) => ({ claim: readLateClaim(r?.lateClaim), name: name(r) })),
  ].filter((d): d is LateClaimDocument => d.claim !== null);
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
