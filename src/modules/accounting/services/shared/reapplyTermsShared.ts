/**
 * What the AP and AR "Re-apply payment terms" services share (payment-terms programme PR 3, AR parity): the refusal
 * type, the limits, the confirmed-item parser, the preview's tick rule and the re-check an apply makes under the row
 * lock. The SQL stays in `ap/reapplyTerms.ts` and `ar/reapplyTerms.ts`: the tables, statuses and lock helpers differ.
 */
import { localDateFromISO } from '@/lib/dateUtils';
import { describePaymentTerms, dueDateFromTerms, readTerms } from './paymentTerms';
import { isDueDateSource, NOTHING_OWING_EPS, type DueDateSource } from './dueDateSource';

/** The most documents one preview lists, and one apply writes. */
export const REAPPLY_MAX = 2000;
export const REAPPLY_EPS = NOTHING_OWING_EPS;
export const REAPPLY_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}$/;

export class ReapplyRefusal extends Error {
  constructor(message: string) { super(message); this.name = 'ReapplyRefusal'; }
}

export type ReapplySkipReason = 'not_found' | 'not_open' | 'date_changed' | 'terms_not_set' | 'terms_changed' | 'already_dated';
export interface ReapplyResult {
  updated: { id: string; invoiceNumber: string; from: string | null; to: string }[];
  skipped: { id: string; reason: ReapplySkipReason }[];
}

/** A confirmed document: its new date, and the due date (null: none) and source the preview showed it with. */
export interface ReapplyItem { id: string; dueDate: string; fromDueDate: string | null; fromSource: DueDateSource }

const isRealDate = (v: unknown): v is string => typeof v === 'string' && ISO.test(v) && localDateFromISO(v) !== null;

/** Parse the confirmed items: every one a document id, a real new date, the previewed date and source; none twice; at most REAPPLY_MAX. */
export function parseReapplyItems(raw: unknown, noun: 'bill' | 'invoice' = 'bill'): ReapplyItem[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new ReapplyRefusal(`items must list at least one ${noun} and its new due date`);
  if (raw.length > REAPPLY_MAX) throw new ReapplyRefusal(`At most ${REAPPLY_MAX} ${noun}s at a time`);
  const seen = new Set<string>();
  const aNoun = noun === 'bill' ? 'a bill' : 'an invoice';
  return raw.map((it, i) => {
    const o = (it ?? {}) as Record<string, unknown>;
    const id = typeof o.id === 'string' ? o.id.toLowerCase() : '';
    const dueDate = typeof o.dueDate === 'string' ? o.dueDate : '';
    if (!REAPPLY_UUID.test(id)) throw new ReapplyRefusal(`items[${i}].id must be ${aNoun} id`);
    if (!isRealDate(dueDate)) throw new ReapplyRefusal(`items[${i}].dueDate must be a real date as YYYY-MM-DD`);
    if (!(o.fromDueDate === null || isRealDate(o.fromDueDate))) {
      throw new ReapplyRefusal(`items[${i}].fromDueDate must be the previewed current due date (YYYY-MM-DD, or null when it had none)`);
    }
    if (!isDueDateSource(o.fromSource)) throw new ReapplyRefusal(`items[${i}].fromSource must be the previewed current source (terms, manual, document or legacy)`);
    if (seen.has(id)) throw new ReapplyRefusal(`items[${i}]: ${noun} ${id} is listed twice`);
    seen.add(id);
    return { id, dueDate, fromDueDate: o.fromDueDate, fromSource: o.fromSource };
  });
}

/** A stored source as the preview reads it: an unknown one is `legacy`. */
export const sourceOfRow = (v: unknown): DueDateSource => (isDueDateSource(v) ? v : 'legacy');

/** A contact's terms columns as the services read them: a number and a type, each null when empty. */
export function contactTermsOf(row: { payment_terms?: unknown; payment_terms_type?: unknown } | undefined): { days: number | null; type: string | null } {
  return {
    days: row?.payment_terms == null ? null : Number(row.payment_terms),
    type: row?.payment_terms_type == null ? null : String(row.payment_terms_type),
  };
}

/** The due date the contact's OWN terms give an invoice date; null when its terms are not set (never the company default). */
export function newDueFromTerms(invoiceDate: string, days: number | null, type: string | null): string | null {
  return readTerms(days, type) ? dueDateFromTerms(invoiceDate, days, type) : null;
}

export interface SkippedTally { id: string; name: string; count: number; balance: number }

/** Count one more open document of a contact whose terms are not set, and add its balance (to the cent). */
export function tallySkipped(tally: Map<string, SkippedTally>, id: string, name: string, balance: number): void {
  const s = tally.get(id) ?? { id, name, count: 0, balance: 0 };
  s.count += 1;
  s.balance = Math.round((s.balance + balance) * 100) / 100;
  tally.set(id, s);
}

/** The contact's terms in words, or "Not set". */
export function fmtTerms(days: number | null, type: string | null): string {
  const t = readTerms(days, type);
  return t ? describePaymentTerms(t.days, t.type) : 'Not set';
}

/**
 * Whether a preview row is ticked, and the note when it is not: a date from terms (or from before sources were
 * recorded) is pre-ticked; one set by hand or by its document is listed unticked.
 */
export function previewTick(source: DueDateSource): { preselected: boolean; note: string | null } {
  const handSet = source === 'manual' || source === 'document';
  return {
    preselected: !handSet,
    note: handSet ? (source === 'manual' ? 'Due date was set by hand' : 'Due date came from the document') : null,
  };
}

export type ReapplyDecision = { skip: ReapplySkipReason } | { write: string };

/**
 * The re-check an apply makes under the document's row lock, in this order: the date or its source moved since the
 * preview (never overwritten unseen); the contact's terms are not set; the terms no longer give the confirmed date; the
 * document is already on that date. Otherwise `write` is the date to store. `newDue` is the contact's own terms for the
 * invoice date, as read now (null: not set).
 */
export function reapplyDecision(
  item: ReapplyItem, current: { dueDate: string | null; source: DueDateSource }, newDue: string | null,
): ReapplyDecision {
  if (current.dueDate !== item.fromDueDate || current.source !== item.fromSource) return { skip: 'date_changed' };
  if (newDue === null) return { skip: 'terms_not_set' };
  if (newDue !== item.dueDate) return { skip: 'terms_changed' };
  if (current.dueDate === newDue) return { skip: 'already_dated' };
  return { write: newDue };
}
