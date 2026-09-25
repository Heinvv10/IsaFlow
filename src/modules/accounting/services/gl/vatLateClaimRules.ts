/**
 * The pure rules of a LATE INPUT-VAT CLAIM (VAT Act s16(3)).
 *
 * Input tax may be deducted in a later tax period, within five years of the
 * period it first became deductible; output tax may never be deferred. So a
 * journal dated inside a locked (filed) VAT period whose only VAT is INPUT tax
 * may be split: the original keeps its date with the input VAT parked on the
 * "Input VAT - late claims" clearing account, and a companion journal on the
 * first day after the lock claims it (vatLateClaimSplit.ts). Everything else
 * keeps today's refusal.
 *
 * Pure: no database, so the rules are tested directly. The reading side is
 * vatLateClaimPlan.ts.
 */
import { RATE_CHECK_TOLERANCE, SA_VAT_RATE, classifyVatJournalLine } from '../reports/vatBoxBasis';
import { classifyNonSupplyAccount, claimsVat } from './nonSupplyAccounts';

/** One journal line with the account facts the rules need. */
export interface LateClaimLine {
  glAccountId: string;
  accountType: string;
  accountSubtype: string | null;
  accountName: string;
  vatInputDenied: boolean;
  vatType: string | null;
  debit: number;
  credit: number;
}

/**
 * Why a locked-period posting cannot be claimed late. `null` on a verdict means
 * the journal is not a late-claim candidate at all (nothing to claim, or VAT
 * the return cannot place) — the caller raises today's plain lock refusal.
 */
export type LateClaimRefusalReason =
  | 'output_vat' | 'input_reduction' | 'expired_5y' | 'claim_period_closed' | 'non_supply';

export type LateClaimVerdict =
  | { claimable: true; inputTax: number }
  | { claimable: false; reason: LateClaimRefusalReason | null };

/** Codes that put a supply in a box at nil tax: not part of the base the 15% check is run on. */
const UNTAXED_CODES: readonly string[] = ['zero_rated', 'export', 'exempt', 'no_vat'];

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * May this journal be split? Uses the VAT201's own line classifier, so "input
 * tax", "base" and "unmapped" mean exactly what the return means by them.
 * Output VAT outranks every other reason: it can never be deferred.
 */
export function qualifiesForLateClaim(lines: readonly LateClaimLine[]): LateClaimVerdict {
  let inputTax = 0;
  let reduction = false;
  let unplaceable = false;
  let nonSupply = false;
  let baseLines = 0;
  let base = 0;        // every base line — the VAT201's own base for the journal
  let codedBase = 0;   // base lines carrying a tax-bearing code
  let coded = false;
  for (const l of lines) {
    const c = classifyVatJournalLine({
      journalEntryId: '', entryNumber: '', entryDate: '', lineId: '',
      accountId: l.glAccountId, accountCode: '', accountName: l.accountName,
      accountType: l.accountType, accountSubtype: l.accountSubtype, vatType: l.vatType,
      debit: l.debit, credit: l.credit, cancelledSource: false,
    });
    const tagged = l.vatType !== null && l.vatType !== 'no_vat';
    if (c.role === 'tax' && c.direction === 'output') return { claimable: false, reason: 'output_vat' };
    if (c.role === 'tax') {
      // Per line, not netted: a credit to input VAT reduces a filed claim.
      if (l.credit > 0) reduction = true;
      inputTax = r2(inputTax + l.debit - l.credit);
    } else if (c.role === 'base' && tagged && l.accountType === 'revenue') {
      return { claimable: false, reason: 'output_vat' };
    } else if (c.role === 'unmapped') {
      unplaceable = true;
    } else if (c.role === 'base') {
      baseLines++;
      base = r2(base + l.debit - l.credit);
      if (l.vatType !== null && !UNTAXED_CODES.includes(l.vatType)) {
        coded = true; codedBase = r2(codedBase + l.debit - l.credit);
      }
      // A line on an account where no input tax may be claimed blocks the claim
      // when it claims VAT — or carries NO code at all: an untagged line gives
      // no way to tell the journal's VAT is not its. Only an explicit
      // non-claiming code (no_vat / exempt) clears it.
      if ((claimsVat(l.vatType) || l.vatType === null)
        && (l.vatInputDenied || classifyNonSupplyAccount(l.accountName) !== null)) nonSupply = true;
    }
  }
  if (reduction) return { claimable: false, reason: 'input_reduction' };
  // No base line: the VAT201 lists such a journal in entriesWithoutBase when it
  // is on time; claimed late it would escape that flag, so it is not claimable.
  if (unplaceable || inputTax <= 0 || baseLines === 0) return { claimable: false, reason: null };
  // The 15% check the VAT201 runs on the journal on time — a late claim's tax is
  // out of its period's base check, so a claim that fails it is not claimable.
  // Coded lines are checked both ways against the claiming base; with no coded
  // line (a bill: its expense lines carry no code) the base is every base line,
  // as deriveVatBoxes takes it, and only an OVER-claim fails — an untaxed item
  // beside a taxed one legitimately puts the tax under 15% of the whole.
  const implied = r2((coded ? codedBase : base) * SA_VAT_RATE);
  const excess = r2(inputTax - implied);
  if (coded ? Math.abs(excess) > RATE_CHECK_TOLERANCE : excess > RATE_CHECK_TOLERANCE) {
    return { claimable: false, reason: null };
  }
  if (nonSupply) return { claimable: false, reason: 'non_supply' };
  return { claimable: true, inputTax };
}

function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export interface LockRange {
  periodStart: string;
  periodEnd: string;
}

/**
 * The claim date: the first day after the lock covering `originalDate` and
 * every lock that follows it back to back. A gap ends the run — the day after
 * the last consecutive lock is an unlocked VAT period. ISO dates compare as
 * strings. Throws when no lock covers the date: that is a caller bug.
 */
export function lateClaimDate(originalDate: string, locks: readonly LockRange[]): string {
  let cover = locks.find((l) => l.periodStart <= originalDate && l.periodEnd >= originalDate);
  if (!cover) throw new Error(`lateClaimDate: no lock covers ${originalDate}`);
  let d = addDays(cover.periodEnd, 1);
  for (let i = 0; i < locks.length; i++) {
    cover = locks.find((l) => l.periodStart <= d && l.periodEnd >= d);
    if (!cover) return d;
    d = addDays(cover.periodEnd, 1);
  }
  return d;
}

/** The last day a claim may be made: the same calendar day five years on (29 Feb clamps to 28 Feb). */
export function lateClaimDeadline(originalDate: string): string {
  const [y, m, d] = originalDate.split('-').map(Number) as [number, number, number];
  const lastOfMonth = new Date(Date.UTC(y + 5, m, 0)).getUTCDate();
  const day = Math.min(d, lastOfMonth);
  return `${y + 5}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function isWithinLateClaimWindow(originalDate: string, claimDate: string): boolean {
  return claimDate <= lateClaimDeadline(originalDate);
}
