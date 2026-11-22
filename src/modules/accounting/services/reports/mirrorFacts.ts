/**
 * THE ONE SOURCE of every sentence about a possible mirrored duplicate: the generator's note, the list's badge, the 409 and the page's confirm.
 *
 * A manual row may be the same sale as mirrored document(s) (intercompany_mirrored_duplicate). What is TRUE about them is read ONCE per row by
 * intercompany_mirror_facts, per mirror: its name, the amount it accounts for (signed: a credit note's is negative), whether it is eliminated
 * automatically for the adjustment's period (intercompany_mirror_stands) and on which date that elimination falls, whose link holds it (this
 * row, another row of the same role, a row of the other role, or none), and whether it matched by its total with VAT. Every claim below is
 * computed from those facts; no path picks a mirror and words it without them. Where the facts are mixed (a month sum of which only part
 * stands) the wording says what part is eliminated and asks for a check, never more than the facts show.
 *
 * Pure (formatMoney only), so the page may use it.
 */
import { formatMoney } from '@/lib/money/formatMoney';

/** Whose active link of the row's role holds a mirror: this row's, another row's ("matched to a different row"), or nobody's. */
export type MirrorLinkState = 'here' | 'elsewhere' | 'none';
export type MirrorRole = 'sale' | 'purchase';

/** One mirrored document the row may duplicate, as verified for the period. */
export interface MirrorFact {
  ref: string;
  /** Signed: a credit note's amount is negative. For a sum matched by totals, its total with VAT. */
  amount: number;
  stands: boolean;
  link: MirrorLinkState;
  /** Matched by its total with VAT (mirroring eliminates the subtotal, net of VAT). */
  byTotal?: boolean;
  /** The date its elimination falls on (the later of its two document dates; may be after the period). */
  elimDate?: string;
  /** Another row's active link of the OTHER role holds it (the other side of a sale). */
  otherRole?: MirrorRole | null;
}

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
const role = (v: unknown): MirrorRole | null => (v === 'sale' || v === 'purchase' ? v : null);
const day = (v: unknown): string => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : '');

/** The facts from intercompany_mirror_facts' rows (one per mirror, in order; elim_date as text), or null when the row matches no mirror. */
export function factsFromRows(rows: Row[] | null | undefined, periodEnd: string): MirrorFacts | null {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const sorted = [...rows].sort((a, b) => Number(a.ord) - Number(b.ord));
  const link = (v: unknown): MirrorLinkState => (v === 'here' || v === 'elsewhere' ? v : 'none');
  return {
    label: String(sorted[0]!.label), sum: sorted[0]!.is_sum === true, periodEnd,
    mirrors: sorted.map((r) => ({ ref: String(r.mirror_ref), amount: Number(r.amount), stands: r.stands === true, link: link(r.link),
      byTotal: r.by_total === true, elimDate: day(r.elim_date), otherRole: role(r.other_role) })),
  };
}

/** The facts as they arrive in JSON (the list item, the 409 details), keeping only a well-formed object; else null. */
export function parseMirrorFacts(raw: unknown): MirrorFacts | null {
  const f = raw as Partial<MirrorFacts> | null;
  if (!f || typeof f.label !== 'string' || !f.label || typeof f.periodEnd !== 'string' || !Array.isArray(f.mirrors) || f.mirrors.length === 0) return null;
  const mirrors = f.mirrors.flatMap((m: Partial<MirrorFact>) => (typeof m?.ref === 'string' && typeof m.amount === 'number' && Number.isFinite(m.amount)
    ? [{ ref: m.ref, amount: m.amount, stands: m.stands === true, link: m.link === 'here' || m.link === 'elsewhere' ? m.link : 'none',
        byTotal: m.byTotal === true, elimDate: day(m.elimDate), otherRole: role(m.otherRole) } as MirrorFact] : []));
  return mirrors.length === f.mirrors.length ? { label: f.label, sum: f.sum === true, mirrors, periodEnd: f.periodEnd } : null;
}

/** Every named mirror is eliminated automatically for the period. */
export const allStand = (f: MirrorFacts): boolean => f.mirrors.every((m) => m.stands);
/** Some named mirror is held by another row's active link of the same role. */
export const anyLinkedElsewhere = (f: MirrorFacts): boolean => f.mirrors.some((m) => m.link === 'elsewhere');
const round2 = (n: number) => Math.round(n * 100) / 100;

/** What is true of one mirror. `short`: the form inside a month sum's list ("eliminated automatically, not matched to any row yet"). */
function state(m: MirrorFact, periodEnd: string, short = false): string {
  if (!m.stands) return `NOT eliminated automatically for the period to ${periodEnd}`;
  const when = m.elimDate && m.elimDate > periodEnd ? ` on ${m.elimDate}, after the period to ${periodEnd}` : '';
  const and = short ? ',' : when ? ', and' : ' and';
  const is = short ? '' : 'is ';
  if (m.link === 'here') return `eliminated automatically${when}${and} ${is}matched to this row`;
  if (m.link === 'elsewhere') return `eliminated automatically${when}, but ${is}matched to a different row`;
  if (m.otherRole) return `eliminated automatically${when}${and} ${is}matched to a ${m.otherRole} row (the other side of a sale), not to any ${m.otherRole === 'sale' ? 'purchase' : 'sale'} row yet`;
  return `eliminated automatically${when}${and} ${is}not matched to any row yet`;
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
  if (!f.sum) {
    const m = f.mirrors[0]!;
    const head = `Possibly the same sale as mirrored document ${m.ref}, which is ${state(m, f.periodEnd)}${cut}`;
    return m.stands ? `${head}. If it is the same sale, ${twice('it')}.` : `${head}: this may be the sale's only elimination.`;
  }
  const byTotal = f.mirrors.some((m) => m.byTotal);
  const withVat = byTotal ? ' with VAT' : '';
  const list = joinAnd(f.mirrors.map((m) => `${m.ref} (${formatMoney(m.amount)}${withVat}: ${state(m, f.periodEnd, true)})`));
  const head = `Possibly the same sale as ${f.label}: ${list}${cut}.`;
  const standingN = f.mirrors.filter((m) => m.stands).length;
  const netOfVat = byTotal ? ', net of their VAT' : '';
  if (standingN === 0) return `${head} None of them is eliminated automatically for the period to ${f.periodEnd}: this may be the sale's only elimination.`;
  if (standingN === f.mirrors.length) return `${head} All of them are eliminated automatically by mirroring${netOfVat}: if it is the same sale, ${twice('it')}.`;
  const part = ctx === 'draft' ? 'posting this in full would eliminate that part twice' : 'that part is eliminated twice';
  // "R P of R T" only where it is a part of the row: every member the same sign as the row, and amounts net of VAT
  const T = round2(f.mirrors.reduce((s, m) => s + m.amount, 0));
  const P = round2(f.mirrors.filter((m) => m.stands).reduce((s, m) => s + m.amount, 0));
  const sameSign = T !== 0 && f.mirrors.every((m) => Math.sign(m.amount) === Math.sign(T));
  return sameSign && !byTotal
    ? `${head} ${formatMoney(P)} of ${formatMoney(T)} is eliminated automatically by mirroring: if it is the same sale, ${part}.`
    : `${head} Only some of them are eliminated automatically by mirroring${netOfVat}: if it is the same sale, ${part}.`;
}

/** The 409 and the page's confirm (the same words). */
export function possibleDuplicateMessage(f: MirrorFacts, pairCutover: string | null = null): string {
  return `${mirrorFactsSentence(f, pairCutover)} Confirm to post it.`;
}

/** The list's badge. `shared`: how many listed adjustments point at the same mirror(s). */
export function duplicateBadgeText(f: MirrorFacts, status: string, pairCutover: string | null = null, shared = 1): string {
  const share = shared > 1 ? ` ${shared} listed eliminations point at this mirror: at most one of them can be its duplicate.` : '';
  if (status !== 'posted') return `${mirrorFactsSentence(f, pairCutover)} Check before posting.${share}`;
  const tail = !f.mirrors.some((m) => m.stands) ? '' : shared > 1 ? ' Check which, and reverse that one only.' : ' Check, and reverse this one if so.';
  return `Posted. ${mirrorFactsSentence(f, pairCutover, 'posted')}${share}${tail}`;
}

/** The stored link's answer for a row on or after its pair's cutover (intercompany_mirror_link), when the row is drafted. */
export interface LinkAnswer { state: string; ref: string }

/** What the generator says when the row matches no mirror: the match window, so a document outside it is not ruled out (a stated limit). */
export const NO_MIRROR_MATCH = 'No mirrored document of the pair matches this row\'s amount in its month or within 7 days of it (documents further away are not compared).';

/**
 * The generator's reason for a drafted, flagged row: before the cutover the facts; on or after it, why the link did not leave it to
 * mirroring (only the two answers that carry a verified fact of their own: its link released, the mirror kept for a closer row) and the facts.
 * It is stored in the draft's description, so it is worded in the past of the run (the generator dates it): the list's badge is the live one.
 */
export function generatorReason(f: MirrorFacts | null, pairCutover: string | null, link: LinkAnswer | null, periodEnd: string): string {
  if (!pairCutover) return f ? mirrorFactsSentence(f) : '';
  const why = link?.state === 'released' && link.ref
    ? ` Its link to mirrored document ${link.ref} was released: that mirror did not eliminate this row for the period to ${periodEnd} when this run was made.`
    : link?.state === 'closer' && link.ref ? ` Mirrored document ${link.ref} belongs to a closer row (that row takes it when its period runs).` : '';
  return `The pair mirrors from ${pairCutover}.${why} ${f ? mirrorFactsSentence(f) : NO_MIRROR_MATCH}`;
}
