/**
 * RULE A (#1701 round 6, the M1 fix): which of a customer credit note's APPLICATIONS count against a typed invoice's
 * remaining credit capacity. Pure; the reader is creditNoteDetachedRead.
 *
 * A note's DETACHED gross D is the share of its total that reversed no invoice leg at its approval:
 *   D = total x (subtotal - SUM(its non-excess credit_note_revenue_allocations)) / subtotal, in exact cents, rounded
 *   once (half away from zero, BigInt). So D = the whole total for an unlinked or late-linked note (no non-excess row;
 *   a late link records only an excess row), 0 for a typed-linked note or a legacy-linked note wholly on its legs,
 *   and the excess share in between (a 200 + 30 note on a legacy 100 + 15 invoice: 115).
 * Its applications (credit_note_allocations) to invoices whose legs it did NOT reverse count there in application
 * order (created_at, invoice_id) until D is used up; its applications to an invoice whose legs it DID reverse never
 * count (that invoice sees the note by its link and its allocation rows). What counts is a GROSS figure; the invoice
 * splits it in its own remaining proportion (creditNoteTypedSplit.appliedSettlement), cumulative per invoice.
 *
 * Why not "every note not linked to the invoice" (round 4): a linked note's FIFO spillover would count twice (L linked
 * to Y reverses Y's legs; its 65 spilled onto W would also use W's capacity, and a genuine return on W be refused).
 * Why not "unlinked notes only": a late link to a legacy invoice would make an earlier application to a typed one stop
 * counting, so the typed invoice could be credited twice. D is counted exactly once over all of a note's invoices.
 *
 * Invoice ids compare lower-case (uuids); the maps returned are keyed lower-case.
 */
import { mulDivRound } from './creditNoteTypedSplit';

export interface DetachedApplication { invoiceId: string; cents: number }

export interface DetachedProfile {
  /** D, in cents. */
  detached: number;
  /** The invoices whose legs the note reversed (it has non-excess credit_note_revenue_allocations rows there). */
  reversedOn: readonly string[];
  /** Its applications in application order (created_at, invoice_id), in cents. */
  applications: readonly DetachedApplication[];
}

const lc = (id: string): string => id.toLowerCase();

/** D in cents from the note's total, subtotal and the net its non-excess allocation rows record (all cents). */
export function detachedGross(totalCents: number, subtotalCents: number, reversedNetCents: number): number {
  if (totalCents <= 0) return 0;
  if (subtotalCents <= 0) return totalCents;
  const unreversed = Math.min(Math.max(subtotalCents - reversedNetCents, 0), subtotalCents);
  return mulDivRound(totalCents, unreversed, subtotalCents);
}

/** What each unreversed invoice's applications of this note count there (cents): D consumed in application order. */
export function detachedCounts(profile: DetachedProfile): Map<string, number> {
  const reversed = new Set(profile.reversedOn.map(lc));
  const out = new Map<string, number>();
  let left = Math.max(profile.detached, 0);
  for (const a of profile.applications) {
    const id = lc(a.invoiceId);
    if (reversed.has(id)) continue;
    const counted = Math.min(Math.max(a.cents, 0), left);
    left -= counted;
    out.set(id, (out.get(id) ?? 0) + counted);
  }
  return out;
}

/**
 * The profile once `planned` lands as the back-fill writes it (add-to-existing): an existing row grows in its place;
 * a new row follows every existing one (a later transaction), the new ones by invoice id (one transaction, one
 * created_at). Returns a new profile.
 */
export function withPlannedApplications(profile: DetachedProfile, planned: readonly DetachedApplication[]): DetachedProfile {
  const existing = profile.applications.map((a) => ({ ...a }));
  const fresh: DetachedApplication[] = [];
  for (const p of planned) {
    const row = existing.find((a) => lc(a.invoiceId) === lc(p.invoiceId)) ?? fresh.find((a) => lc(a.invoiceId) === lc(p.invoiceId));
    if (row) row.cents += p.cents;
    else fresh.push({ ...p });
  }
  fresh.sort((a, b) => (lc(a.invoiceId) < lc(b.invoiceId) ? -1 : lc(a.invoiceId) > lc(b.invoiceId) ? 1 : 0));
  return { ...profile, applications: [...existing, ...fresh] };
}

/** How landing `planned` changes what the note counts on each invoice (after less before, cents; may be negative). */
export function detachedCountDelta(profile: DetachedProfile, planned: readonly DetachedApplication[]): Map<string, number> {
  const before = detachedCounts(profile);
  const after = detachedCounts(withPlannedApplications(profile, planned));
  const out = new Map<string, number>();
  for (const id of new Set([...before.keys(), ...after.keys()])) out.set(id, (after.get(id) ?? 0) - (before.get(id) ?? 0));
  return out;
}
