/**
 * What a proposed GL account merge would do, in enough detail for a person to
 * decide on it — because the decision is a person's, not an agent's.
 *
 * This is the product. The live merge is a production data correction and is
 * nobody's to run unattended; the preview is what gets read first. So it does
 * not return a count and a message. It returns both accounts' figures derived
 * separately, the trial balance either side of the move, the journal entries as
 * ids you can go and open, every row that would not move and why, and what
 * breaks if the proposal is wrong.
 */
import { createHash } from 'crypto';
import {
  AccountMergeError, MAX_TREE_DEPTH, assertMergeable, loadMergeAccount,
  reportingClassFor, type MergeAccount, type ReportingClass,
} from './accountMergeGuards';
import { CAVEAT, CLASS_NOTE, SYSTEM_NOTE } from './accountMergeNotes';
import {
  accountsWithPostedLines, classifySourceLines, descendantsOf, postedThroughForAccounts,
  postedTotalsExcluding, postedTotalsForAccount, postedTotalsForCompany, systemClaimantsForSubtype,
  type LedgerTotals, type MergeSkip, type MovableLine,
} from './accountMergeFigures';

/**
 * `entries` carries a LINE-level sample; `entryIds` carries the complete list.
 *
 * The design premise is that the dry run is the document a person signs, and a
 * 200-entry sample is not that for a 356-entry merge: 156 entries of R37.7m
 * would be named nowhere. But the full detail cannot simply be uncapped either
 * — 356 entries with their lines is around 90KB and `vat_status` already
 * exceeds the response limit at 67KB.
 *
 * So the two are separated. The detailed sample stays at 200; the bare id list
 * runs to 1,000, which covers both merges this tool was built for (356 and 74)
 * completely. Above that, `movedLinesDigest` is what carries the commitment:
 * it is a hash of EVERY moved line id in order, is never truncated, and is
 * stored on the `gl_account_merges` record — so the signed preview and the
 * record afterwards can be compared line-for-line even when neither list is
 * printed in full.
 */
const SAMPLE_CAP = 200;
const ENTRY_ID_CAP = 1000;

export interface AccountFigures {
  accountId: string;
  accountCode: string;
  accountName: string;
  accountType: string;
  accountSubtype: string | null;
  isSystemAccount: boolean;
  isActive: boolean;
  postedLines: number;
  postedDebit: number;
  postedCredit: number;
  postedNet: number;
}

export interface MergeEntry {
  journalEntryId: string;
  entryNumber: string | null;
  entryDate: string;
  status: string;
  debit: number;
  credit: number;
  lines: { journalLineId: string; debit: number; credit: number }[];
}

export interface MergePreview {
  source: AccountFigures;
  target: AccountFigures;
  sourceAfter: { postedLines: number; postedDebit: number; postedCredit: number; postedNet: number };
  targetAfter: { postedLines: number; postedDebit: number; postedCredit: number; postedNet: number };
  linesToRepoint: number;
  entries: MergeEntry[];
  entriesTotal: number;
  truncatedEntries: boolean;
  /** Complete ordered list of the entries that would move, up to ENTRY_ID_CAP. */
  entryIds: string[];
  truncatedEntryIds: boolean;
  /** sha256 over EVERY moved line id, in order. Never truncated. */
  movedLinesDigest: string;
  skips: MergeSkip[];
  skipsTotal: number;
  truncatedSkips: boolean;
  /** True when at least one row cannot move. The live merge refuses in that state. */
  blocked: boolean;
  trialBalance: {
    before: { totalDebit: number; totalCredit: number; difference: number; accountsWithPostedLines: number };
    after: { totalDebit: number; totalCredit: number; difference: number; accountsWithPostedLines: number };
    unchanged: boolean;
    identity: { otherAccountsDebit: number; otherAccountsCredit: number; expression: string; holds: boolean };
    caveat: string;
  };
  childAccounts: { accountId: string; accountCode: string; accountName: string; level: number; levelAfter: number; isDirectChild: boolean }[];
  reportingClass: {
    source: ReportingClass;
    target: ReportingClass;
    note: string;
  };
  systemAccountImpact: {
    sourceIsSystemAccount: boolean;
    targetIsSystemAccount: boolean;
    sourceClaimsSubtype: string | null;
    targetClaimsSubtype: string | null;
    targetSubtypeClaimants: { accountId: string; accountCode: string; accountName: string; accountType: string }[];
    note: string;
  };
  postedThrough: string | null;
}

/**
 * sha256 over the moved line ids — the commitment a capped list cannot make.
 *
 * SORTED, deliberately. The preview lists lines in reporting order (entry date,
 * then entry number) and the write returns them in whatever order the UPDATE
 * emitted; an order-sensitive digest would then differ between the document a
 * person signed and the record of what ran, for no reason at all. Sorting makes
 * the digest a function of the SET, which is the thing being committed to.
 */
export function digestLineIds(ids: readonly string[]): string {
  return createHash('sha256').update([...ids].sort().join('\n')).digest('hex');
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function figuresFor(account: MergeAccount, posted: LedgerTotals): AccountFigures {
  return {
    accountId: account.id,
    accountCode: account.accountCode,
    accountName: account.accountName,
    accountType: account.accountType,
    accountSubtype: account.accountSubtype,
    isSystemAccount: account.isSystemAccount,
    isActive: account.isActive,
    postedLines: posted.lines,
    postedDebit: round(posted.debit),
    postedCredit: round(posted.credit),
    postedNet: round(posted.debit - posted.credit),
  };
}

/** Only POSTED movable lines shift a balance; drafts move but change no figure. */
function postedMovement(lines: MovableLine[]): LedgerTotals {
  const posted = lines.filter((l) => l.status === 'posted');
  return {
    lines: posted.length,
    debit: posted.reduce((s, l) => s + l.debit, 0),
    credit: posted.reduce((s, l) => s + l.credit, 0),
  };
}

function groupIntoEntries(lines: MovableLine[]): MergeEntry[] {
  const byEntry = new Map<string, MergeEntry>();
  for (const l of lines) {
    const existing = byEntry.get(l.journalEntryId);
    const entry = existing ?? {
      journalEntryId: l.journalEntryId,
      entryNumber: l.entryNumber,
      entryDate: l.entryDate,
      status: l.status,
      debit: 0,
      credit: 0,
      lines: [],
    };
    entry.debit = round(entry.debit + l.debit);
    entry.credit = round(entry.credit + l.credit);
    entry.lines.push({ journalLineId: l.journalLineId, debit: l.debit, credit: l.credit });
    if (!existing) byEntry.set(l.journalEntryId, entry);
  }
  return [...byEntry.values()];
}

export async function previewAccountMerge(
  companyId: string, sourceId: string, targetId: string,
): Promise<MergePreview> {
  const source = await loadMergeAccount(companyId, sourceId);
  const target = await loadMergeAccount(companyId, targetId);
  if (!source || !target) throw new AccountMergeError('Not found', 'account_not_found');
  await assertMergeable(companyId, source, target);

  const [sourcePosted, targetPosted, companyPosted, otherPosted, accountCount] = await Promise.all([
    postedTotalsForAccount(companyId, source.id),
    postedTotalsForAccount(companyId, target.id),
    postedTotalsForCompany(companyId),
    postedTotalsExcluding(companyId, source.id, target.id),
    accountsWithPostedLines(companyId),
  ]);
  const { movable, skips } = await classifySourceLines(companyId, source.id);
  const descendants = await descendantsOf(companyId, source.id, MAX_TREE_DEPTH);
  const claimants = await systemClaimantsForSubtype(companyId, target.accountSubtype);
  const postedThrough = await postedThroughForAccounts(companyId, source.id, target.id);

  const moving = postedMovement(movable);
  const entries = groupIntoEntries(movable);
  const levelDelta = target.level - source.level;

  const identityDebit = otherPosted.debit + sourcePosted.debit + targetPosted.debit;
  const identityCredit = otherPosted.credit + sourcePosted.credit + targetPosted.credit;
  const holds = Math.abs(identityDebit - companyPosted.debit) < 0.005
    && Math.abs(identityCredit - companyPosted.credit) < 0.005;

  const sourceLinesAfter = sourcePosted.lines - moving.lines;
  const before = {
    totalDebit: round(companyPosted.debit),
    totalCredit: round(companyPosted.credit),
    difference: round(companyPosted.debit - companyPosted.credit),
    accountsWithPostedLines: accountCount,
  };

  return {
    source: figuresFor(source, sourcePosted),
    target: figuresFor(target, targetPosted),
    sourceAfter: {
      postedLines: sourceLinesAfter,
      postedDebit: round(sourcePosted.debit - moving.debit),
      postedCredit: round(sourcePosted.credit - moving.credit),
      postedNet: round((sourcePosted.debit - moving.debit) - (sourcePosted.credit - moving.credit)),
    },
    targetAfter: {
      postedLines: targetPosted.lines + moving.lines,
      postedDebit: round(targetPosted.debit + moving.debit),
      postedCredit: round(targetPosted.credit + moving.credit),
      postedNet: round((targetPosted.debit + moving.debit) - (targetPosted.credit + moving.credit)),
    },
    linesToRepoint: movable.length,
    entries: entries.slice(0, SAMPLE_CAP),
    entriesTotal: entries.length,
    truncatedEntries: entries.length > SAMPLE_CAP,
    entryIds: entries.slice(0, ENTRY_ID_CAP).map((e) => e.journalEntryId),
    truncatedEntryIds: entries.length > ENTRY_ID_CAP,
    movedLinesDigest: digestLineIds(movable.map((l) => l.journalLineId)),
    skips: skips.slice(0, SAMPLE_CAP),
    skipsTotal: skips.length,
    truncatedSkips: skips.length > SAMPLE_CAP,
    blocked: skips.length > 0,
    trialBalance: {
      before,
      after: {
        ...before,
        // Down one when the source empties, UP one when the target had nothing
        // posted and gains its first line. Reporting only the decrement made
        // this wrong by one in a figure that exists for a human to sign.
        accountsWithPostedLines: accountCount
          - (sourcePosted.lines > 0 && sourceLinesAfter === 0 ? 1 : 0)
          + (targetPosted.lines === 0 && moving.lines > 0 ? 1 : 0),
      },
      unchanged: true,
      identity: {
        otherAccountsDebit: round(otherPosted.debit),
        otherAccountsCredit: round(otherPosted.credit),
        expression: 'otherAccounts + source + target === companyTotal',
        holds,
      },
      caveat: CAVEAT,
    },
    childAccounts: descendants.map((d) => ({ ...d, levelAfter: d.level + levelDelta })),
    reportingClass: {
      source: reportingClassFor(source.accountSubtype),
      target: reportingClassFor(target.accountSubtype),
      note: CLASS_NOTE,
    },
    systemAccountImpact: {
      sourceIsSystemAccount: source.isSystemAccount,
      targetIsSystemAccount: target.isSystemAccount,
      sourceClaimsSubtype: source.isSystemAccount ? source.accountSubtype : null,
      targetClaimsSubtype: target.isSystemAccount ? target.accountSubtype : null,
      targetSubtypeClaimants: claimants,
      note: SYSTEM_NOTE,
    },
    postedThrough,
  };
}
