/**
 * "Due by date" report: pure bucketing over the open documents the AP and AR
 * aging already produce (ap/apAgingInvoices, ar/arAgingInvoices), so the report
 * cannot disagree with the aging about which documents are open or what each
 * owes. No I/O here: the page imports this too.
 *
 * Per contact, four mutually exclusive columns, all as at TODAY:
 *   overdueNow      due before today
 *   dueTodayToDate  due from today up to and including `byDate`
 *   dueLater        due after `byDate`
 *   noDueDate       no due date recorded (the aging ages these from the invoice
 *                   date; here the raw NULL decides, so they are not guessed)
 * `totalByDate` = overdueNow + dueTodayToDate: what must be settled by `byDate`.
 *
 * FOOTING: the four columns add to what calculateAgingBuckets reports as the
 * total. That means the aging's own rules are mirrored on purpose: balances <= 0
 * are dropped, and an AR open dispute is taken out of the columns and reported
 * apart as `disputed` (aging total + disputed = the gross balance). Unallocated
 * AR credit notes carry a negative balance, which aging drops, so they are not
 * here either.
 *
 * Money is added in integer cents so a column never drifts by a cent.
 */

import type { OpenAgingInvoice } from './aging';

export type DueSide = 'ap' | 'ar';
export type DueBucket = 'overdueNow' | 'dueTodayToDate' | 'dueLater' | 'noDueDate';

export interface DueByDateTotals {
  overdueNow: number;
  dueTodayToDate: number;
  /** overdueNow + dueTodayToDate. */
  totalByDate: number;
  dueLater: number;
  noDueDate: number;
  /** The four columns: equals the aging total for the same contacts. */
  total: number;
  /** Open dispute held out of the columns (AR only; always 0 for AP). */
  disputed: number;
}

export interface DueByDateInvoice {
  id: string;
  invoiceNumber: string;
  invoiceDate: string;
  /** The recorded due date; null when none is recorded. */
  dueDate: string | null;
  /** Open balance before disputes. */
  balance: number;
  disputed: number;
  /** balance - disputed: the amount in the column. */
  counted: number;
  bucket: DueBucket;
}

/** A contact's row: the five columns only. The summary the page and the MCP tool list carries these. */
export interface DueByDateContact extends DueByDateTotals {
  contactId: string;
  contactName: string;
}

/** One contact with its invoices: the drill-down, read on demand so the summary stays small. */
export interface DueByDateContactDetail extends DueByDateContact {
  invoices: DueByDateInvoice[];
}

export interface DueByDateSide<C extends DueByDateContact = DueByDateContact> {
  side: DueSide;
  today: string;
  byDate: string;
  contacts: C[];
  totals: DueByDateTotals;
}

export interface DueByDateReport<C extends DueByDateContact = DueByDateContact> {
  today: string;
  byDate: string;
  ap: DueByDateSide<C>;
  ar: DueByDateSide<C>;
  /**
   * AR totalByDate minus AP totalByDate. It leaves out every document with no
   * due date (`noDueDate` in each side's totals): those cannot be placed in time.
   */
  netPosition: number;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

function isRealDate(s: string): boolean {
  if (!ISO.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Why `byDate` is refused, or null when it is a real date that is today or later. */
export function byDateError(byDate: string, today: string): string | null {
  if (!isRealDate(byDate)) return 'by_date must be a real date in YYYY-MM-DD format';
  if (byDate < today) return `by_date must be today or later (today is ${today})`;
  return null;
}

/** Last day of the month of `iso` (YYYY-MM-DD). */
export function endOfMonth(iso: string): string {
  const [y, m] = iso.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
}

/** YYYY-MM-DD strings compare correctly as text. */
export function classifyDue(dueDate: string | null, today: string, byDate: string): DueBucket {
  if (dueDate === null) return 'noDueDate';
  if (dueDate < today) return 'overdueNow';
  if (dueDate <= byDate) return 'dueTodayToDate';
  return 'dueLater';
}

const toCents = (n: number): number => Math.round(n * 100);
const fromCents = (c: number): number => c / 100;

interface CentsTotals { overdueNow: number; dueTodayToDate: number; dueLater: number; noDueDate: number; disputed: number }
const emptyCents = (): CentsTotals => ({ overdueNow: 0, dueTodayToDate: 0, dueLater: 0, noDueDate: 0, disputed: 0 });

function finish(c: CentsTotals): DueByDateTotals {
  return {
    overdueNow: fromCents(c.overdueNow),
    dueTodayToDate: fromCents(c.dueTodayToDate),
    totalByDate: fromCents(c.overdueNow + c.dueTodayToDate),
    dueLater: fromCents(c.dueLater),
    noDueDate: fromCents(c.noDueDate),
    total: fromCents(c.overdueNow + c.dueTodayToDate + c.dueLater + c.noDueDate),
    disputed: fromCents(c.disputed),
  };
}

/** The recorded due date as YYYY-MM-DD, or null. `dueDate` on an aging row is the invoice date when none is recorded. */
function recordedDueDate(row: OpenAgingInvoice): string | null {
  if (row.dueDateMissing) return null;
  const s = String(row.dueDate);
  return s.includes('T') ? s.split('T')[0]! : s;
}

export function buildDueByDateSide(
  side: DueSide,
  rows: OpenAgingInvoice[],
  today: string,
  byDate: string,
): DueByDateSide<DueByDateContactDetail> {
  const grand = emptyCents();
  const perContact = new Map<string, { name: string; cents: CentsTotals; invoices: DueByDateInvoice[] }>();

  for (const row of rows) {
    if (!(row.balance > 0)) continue; // aging drops every balance <= 0
    const balance = toCents(row.balance);
    const disputed = Math.min(Math.max(toCents(row.disputedAmount ?? 0), 0), balance);
    const counted = balance - disputed;
    const dueDate = recordedDueDate(row);
    const bucket = classifyDue(dueDate, today, byDate);

    let entry = perContact.get(row.entityId);
    if (!entry) {
      entry = { name: row.entityName, cents: emptyCents(), invoices: [] };
      perContact.set(row.entityId, entry);
    }
    entry.cents[bucket] += counted;
    entry.cents.disputed += disputed;
    grand[bucket] += counted;
    grand.disputed += disputed;
    entry.invoices.push({
      id: row.id,
      invoiceNumber: row.invoiceNumber,
      invoiceDate: row.invoiceDate,
      dueDate,
      balance: fromCents(balance),
      disputed: fromCents(disputed),
      counted: fromCents(counted),
      bucket,
    });
  }

  const contacts: DueByDateContactDetail[] = [...perContact.entries()].map(([contactId, e]) => ({
    contactId,
    contactName: e.name,
    ...finish(e.cents),
    invoices: e.invoices,
  }));
  contacts.sort((a, b) => b.totalByDate - a.totalByDate || a.contactName.localeCompare(b.contactName));

  return { side, today, byDate, contacts, totals: finish(grand) };
}

/** Net cash position by `byDate`: what customers owe by then less what suppliers are owed by then. */
export function netPosition(ar: DueByDateTotals, ap: DueByDateTotals): number {
  return fromCents(toCents(ar.totalByDate) - toCents(ap.totalByDate));
}

/** The same side without the invoice lists. */
export function withoutInvoices(side: DueByDateSide<DueByDateContactDetail>): DueByDateSide {
  return { ...side, contacts: side.contacts.map(({ invoices: _invoices, ...contact }) => contact) };
}

/** The report without any invoice lists: contacts, totals and the net position. */
export function reportWithoutInvoices(report: DueByDateReport<DueByDateContactDetail>): DueByDateReport {
  return { ...report, ap: withoutInvoices(report.ap), ar: withoutInvoices(report.ar) };
}
