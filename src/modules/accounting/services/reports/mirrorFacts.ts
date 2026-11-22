/**
 * THE ONE SOURCE of every sentence about a possible mirrored duplicate: the generator's note, the list's badge, the 409 and the page's confirm.
 *
 * A manual row may be the same sale as mirrored document(s) (intercompany_mirrored_duplicate). What is TRUE about them is read ONCE per row by
 * intercompany_mirror_facts, per mirror: its name, the amount it accounts for, whether it is eliminated automatically for the adjustment's period
 * (intercompany_mirror_stands), and whose active link holds it (this row, another row of the same role, or none). Every claim below is computed
 * from those facts; no path picks a mirror and words it without them. Where the facts are mixed (a month sum of which only part stands) the
 * wording says how much of the row is eliminated automatically and asks for a check, never more than the facts show.
 *
 * Pure (formatMoney only), so the page may use it.
 */
import { formatMoney } from '@/lib/money/formatMoney';

/** Whose active link holds a mirror: this row's, another row's of the same role ("matched to a different row"), or nobody's. */
export type MirrorLinkState = 'here' | 'elsewhere' | 'none';

/** One mirrored document the row may duplicate, as verified for the period. */
export interface MirrorFact { ref: string; amount: number; stands: boolean; link: MirrorLinkState }

/** The verified facts of a row's possible mirrored duplicate: one mirror, or the month's mirrors whose amounts sum to the row's. */
export interface MirrorFacts {
  /** The mirror's description, or "N mirrored documents of <month>" for a sum. */
  label: string;
  sum: boolean;
  mirrors: MirrorFact[];
  /** The end of the period the facts were judged for (the adjustment's period end). */
  periodEnd: string;
}

type Row = Record<string, unknown>;

/** The facts from intercompany_mirror_facts' rows (one per mirror, in order), or null when the row matches no mirror. */
export function factsFromRows(rows: Row[] | null | undefined, periodEnd: string): MirrorFacts | null {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const sorted = [...rows].sort((a, b) => Number(a.ord) - Number(b.ord));
  const link = (v: unknown): MirrorLinkState => (v === 'here' || v === 'elsewhere' ? v : 'none');
  return {
    label: String(sorted[0]!.label), sum: sorted[0]!.is_sum === true, periodEnd,
    mirrors: sorted.map((r) => ({ ref: String(r.mirror_ref), amount: Number(r.amount), stands: r.stands === true, link: link(r.link) })),
  };
}

/** The facts as they arrive in JSON (the list item, the 409 details), keeping only a well-formed object; else null. */
export function parseMirrorFacts(raw: unknown): MirrorFacts | null {
  const f = raw as Partial<MirrorFacts> | null;
  if (!f || typeof f.label !== 'string' || !f.label || typeof f.periodEnd !== 'string' || !Array.isArray(f.mirrors) || f.mirrors.length === 0) return null;
  const mirrors = f.mirrors.flatMap((m: Partial<MirrorFact>) => (typeof m?.ref === 'string' && typeof m.amount === 'number' && Number.isFinite(m.amount)
    ? [{ ref: m.ref, amount: m.amount, stands: m.stands === true, link: m.link === 'here' || m.link === 'elsewhere' ? m.link : 'none' } as MirrorFact] : []));
  return mirrors.length === f.mirrors.length ? { label: f.label, sum: f.sum === true, mirrors, periodEnd: f.periodEnd } : null;
}

/** Every named mirror is eliminated automatically for the period. */
export const allStand = (f: MirrorFacts): boolean => f.mirrors.every((m) => m.stands);
/** Some named mirror is held by another row's active link. */
export const anyLinkedElsewhere = (f: MirrorFacts): boolean => f.mirrors.some((m) => m.link === 'elsewhere');
const round2 = (n: number) => Math.round(n * 100) / 100;
const total = (f: MirrorFacts) => round2(f.mirrors.reduce((s, m) => s + m.amount, 0));
const standing = (f: MirrorFacts) => round2(f.mirrors.filter((m) => m.stands).reduce((s, m) => s + m.amount, 0));

/** What is true of one mirror. `short`: the form inside a month sum's list ("eliminated automatically, not matched to any row yet"). */
function state(m: MirrorFact, periodEnd: string, short = false): string {
  if (!m.stands) return `NOT eliminated automatically for the period to ${periodEnd}`;
  const is = short ? '' : 'is ';
  if (m.link === 'here') return `eliminated automatically${short ? ',' : ' and'} ${is}matched to this row`;
  if (m.link === 'elsewhere') return `eliminated automatically, but ${is}matched to a different row`;
  return `eliminated automatically${short ? ',' : ' and'} ${is}not matched to any row yet`;
}

const joinAnd = (xs: string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/** Whether the row is still to be posted (a draft: "posting this would ...") or already posted ("it is ..."). */
export type DuplicateContext = 'draft' | 'posted';

/**
 * The sentence(s) the facts support. `pairCutover`: the row is on or after its pair's cutover (said in brackets, as the reason it was drafted
 * although a mirror may account for it).
 */
export function mirrorFactsSentence(f: MirrorFacts, pairCutover: string | null = null, ctx: DuplicateContext = 'draft'): string {
  const cut = pairCutover ? ` (the pair mirrors from ${pairCutover})` : '';
  const twice = (what: string) => (ctx === 'draft' ? `posting this would eliminate ${what} twice` : `${what} is eliminated twice`);
  const P = standing(f); const T = total(f);
  if (!f.sum) {
    const m = f.mirrors[0]!;
    const head = `Possibly the same sale as mirrored document ${m.ref}, which is ${state(m, f.periodEnd)}${cut}`;
    return m.stands ? `${head}. If it is the same sale, ${twice('it')}.` : `${head}: this may be the sale's only elimination.`;
  }
  const list = joinAnd(f.mirrors.map((m) => `${m.ref} (${formatMoney(m.amount)}: ${state(m, f.periodEnd, true)})`));
  const head = `Possibly the same sale as ${f.label}: ${list}${cut}.`;
  if (P <= 0) return `${head} None of them is eliminated automatically for the period to ${f.periodEnd}: this may be the sale's only elimination.`;
  return P >= T
    ? `${head} ${formatMoney(P)} of ${formatMoney(T)} is eliminated automatically by mirroring, in full: if it is the same sale, ${twice('it')}.`
    : `${head} ${formatMoney(P)} of ${formatMoney(T)} is eliminated automatically by mirroring: if it is the same sale, ${ctx === 'draft' ? 'posting this in full would eliminate that part twice' : 'that part is eliminated twice'}.`;
}

/** The 409 and the page's confirm (the same words). */
export function possibleDuplicateMessage(f: MirrorFacts, pairCutover: string | null = null): string {
  return `${mirrorFactsSentence(f, pairCutover)} Confirm to post it.`;
}

/** The list's badge. `shared`: how many listed adjustments point at the same mirror(s). */
export function duplicateBadgeText(f: MirrorFacts, status: string, pairCutover: string | null = null, shared = 1): string {
  const share = shared > 1 ? ` ${shared} listed eliminations point at this mirror: at most one of them can be its duplicate.` : '';
  if (status !== 'posted') return `${mirrorFactsSentence(f, pairCutover)} Check before posting.${share}`;
  const tail = standing(f) <= 0 ? '' : shared > 1 ? ' Check which, and reverse that one only.' : ' Check, and reverse this one if so.';
  return `Posted. ${mirrorFactsSentence(f, pairCutover, 'posted')}${share}${tail}`;
}

/** The stored link's answer for a row on or after its pair's cutover (intercompany_mirror_link), when the row is drafted. */
export interface LinkAnswer { state: string; ref: string }

/**
 * The generator's reason for a drafted, flagged row: before the cutover the facts; on or after it, why the link did not leave it to
 * mirroring (only the two answers that carry a verified fact of their own: its link released, the mirror kept for a closer row) and the facts.
 */
export function generatorReason(f: MirrorFacts | null, pairCutover: string | null, link: LinkAnswer | null, periodEnd: string): string {
  if (!pairCutover) return f ? mirrorFactsSentence(f) : '';
  const why = link?.state === 'released' && link.ref
    ? ` Its link to mirrored document ${link.ref} was released: that mirror no longer eliminates this row for the period to ${periodEnd}.`
    : link?.state === 'closer' && link.ref ? ` Mirrored document ${link.ref} belongs to a closer row (that row takes it when its period runs).` : '';
  return `The pair mirrors from ${pairCutover}.${why} ${f ? mirrorFactsSentence(f) : 'No mirrored document matches this row.'}`;
}
