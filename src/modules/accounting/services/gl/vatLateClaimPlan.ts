/**
 * The reading side of a LATE INPUT-VAT CLAIM (VAT Act s16(3)): given a journal
 * dated inside an active VAT lock, may it be split (vatLateClaimSplit.ts), and
 * on what date is the tax claimed? The rules themselves are pure, in
 * vatLateClaimRules.ts.
 *
 * OPT-IN ONLY. A caller reaches this only when it passes
 * `allowLateInputClaim: true` — human-initiated paths (bill approve / Post to
 * GL, manual journals, expense claims, user bank allocations, MCP tools given
 * the explicit argument). Every unattended poster keeps the plain
 * VatPeriodLockedError, because nobody is there to be told the VAT moved.
 *
 * Refusals are thrown BEFORE any write, as `VatLateClaimRefusal` — a subclass
 * of VatPeriodLockedError, so every route and the MCP boundary that already
 * answers the lock with a 4xx answers these the same way (same `code`).
 */
import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import {
  VatPeriodLockedError,
  findActiveVatLock,
  journalMovesVatFigure,
  takeVatLockShared,
  type ActiveVatLock,
  type SqlExec,
} from './journalVatLockGuard';
import { isDateAutoCreatable } from './journalEntryReversalVatRoll';
import { canonicalSubtype } from './accountSubtypes';
import { getSystemAccountId } from './systemAccountResolver';
import {
  isWithinLateClaimWindow,
  lateClaimDate,
  lateClaimBases,
  lateClaimDeadline,
  qualifiesForLateClaim,
  type LateClaimLine,
  type LateClaimRefusalReason,
} from './vatLateClaimRules';

type Row = Record<string, unknown>;

/** A journal line as the planner needs it. `id` is present on a stored draft. */
export interface LateClaimInputLine {
  id?: string;
  glAccountId: string;
  vatType?: string | null;
  debit: number;
  credit: number;
}

/** `allowLateInputClaim`: a HUMAN-initiated caller opts in to the s16(3) split. */
export interface PostJournalOpts {
  allowLateInputClaim?: boolean;
}

/** What a split posting reports back to its caller (and the API response). */
export interface LateClaimInfo {
  /** The date the input VAT was claimed on: the companion's entry_date. */
  claimDate: string;
  /** The locked VAT period the original is dated in. */
  lockPeriod: { start: string; end: string };
  companionEntryId: string;
  companionEntryNumber: string;
  inputTax: number;
  message: string;
}

export interface LateClaimPlan {
  lock: ActiveVatLock;
  /** The "Input VAT - late claims" account (migration 701). */
  clearingId: string;
  claimDate: string;
  inputTax: number;
  /** The draft's input-VAT lines (ids present only for a stored draft). */
  /** `base`: the base behind each claim, stored on the companion line (late_claim_base). */
  taxLines: { id?: string; glAccountId: string; amount: number; vatType: string | null; base: number }[];
}

const REASON_TEXT: Record<LateClaimRefusalReason, string> = {
  output_vat: 'it carries OUTPUT VAT, which may never be deferred to a later period',
  input_reduction: 'it reduces input VAT (a credit to VAT Input), which changes the filed return',
  expired_5y: 'the claim would fall more than five years after the document date (VAT Act s16(3))',
  claim_period_closed: 'the first open VAT period after the lock is not in an open fiscal period',
  non_supply: 'it claims VAT on an account where no input tax may be claimed (a non-supply or VAT-denied account)',
};

/**
 * A locked-period posting that cannot be claimed late. IS-A VatPeriodLockedError
 * (same `code`), so nothing that maps the lock needs to learn a new type.
 */
export class VatLateClaimRefusal extends VatPeriodLockedError {
  readonly reason: LateClaimRefusalReason;
  constructor(date: string, lock: ActiveVatLock, reason: LateClaimRefusalReason, detail?: string) {
    super(date, lock, undefined,
      `Cannot post on ${date}: it falls inside the VAT period ${lock.periodStart} to ${lock.periodEnd}, `
      + `which is locked because its VAT201 has been filed, and the VAT cannot be claimed in a later period `
      + `because ${REASON_TEXT[reason]}${detail ? ` (${detail})` : ''}. Date it outside the locked period, or an `
      + 'owner or admin can unlock the period (with a reason) if the return is being amended.');
    this.name = 'VatLateClaimRefusal';
    this.reason = reason;
  }
}

/** Is `date` postable: an open covering period, or none that posting would create? */
async function claimDatePostable(companyId: string, date: string, q: SqlExec): Promise<boolean> {
  const rows = (await q`
    SELECT status FROM fiscal_periods
    WHERE company_id = ${companyId}::UUID AND start_date <= ${date}::DATE AND end_date >= ${date}::DATE
    LIMIT 1`) as Row[];
  if (rows[0]) return String(rows[0].status) === 'open';
  return isDateAutoCreatable(companyId, date);
}

/**
 * Null when the journal is not inside an active lock or moves no VAT figure
 * (post it normally). Otherwise the split plan, or a throw: today's plain
 * VatPeriodLockedError when the journal is no late-claim candidate at all, a
 * VatLateClaimRefusal naming the reason when it is one that s16(3) refuses.
 * Takes the shared VAT key first, like the guard it stands in for.
 */
export async function planLockedVatPosting(
  companyId: string,
  entryDate: string | Date,
  lines: readonly LateClaimInputLine[],
  q: SqlExec = sql,
): Promise<LateClaimPlan | null> {
  await takeVatLockShared(companyId, q);
  const date = fmtDate(entryDate);
  const lock = await findActiveVatLock(companyId, date, q);
  if (!lock || !(await journalMovesVatFigure(companyId, lines, q))) return null;

  const ids = [...new Set(lines.map((l) => l.glAccountId))];
  const accounts = new Map(((await q`
    SELECT id, account_type, account_subtype, account_name, COALESCE(vat_input_denied, false) AS denied
    FROM gl_accounts WHERE company_id = ${companyId}::UUID AND id = ANY(${ids}::UUID[])`) as Row[])
    .map((r) => [String(r.id), r]));
  const facts: LateClaimLine[] = lines.map((l) => {
    const a = accounts.get(l.glAccountId);
    return {
      glAccountId: l.glAccountId,
      accountType: String(a?.account_type ?? ''),
      accountSubtype: a?.account_subtype == null ? null : String(a.account_subtype),
      accountName: String(a?.account_name ?? ''),
      vatInputDenied: a?.denied === true,
      vatType: l.vatType ?? null,
      debit: Number(l.debit),
      credit: Number(l.credit),
    };
  });

  const verdict = qualifiesForLateClaim(facts);
  if (!verdict.claimable) {
    if (verdict.reason === null) throw new VatPeriodLockedError(date, lock);
    throw new VatLateClaimRefusal(date, lock, verdict.reason);
  }

  const lockRows = (await q`
    SELECT period_start, period_end FROM vat_period_locks
    WHERE company_id = ${companyId}::UUID AND unlocked_at IS NULL AND period_end >= ${date}::DATE`) as Row[];
  const claimDate = lateClaimDate(date, lockRows.map((r) => ({
    periodStart: fmtDate(r.period_start as string), periodEnd: fmtDate(r.period_end as string),
  })));
  if (!isWithinLateClaimWindow(date, claimDate)) {
    throw new VatLateClaimRefusal(date, lock, 'expired_5y', `the last day to claim was ${lateClaimDeadline(date)}`);
  }
  if (!(await claimDatePostable(companyId, claimDate, q))) {
    throw new VatLateClaimRefusal(date, lock, 'claim_period_closed', `the claim date would be ${claimDate}`);
  }

  // Resolved HERE, not in the split: a company without the account is refused
  // (MissingSystemAccountError) before createJournalEntry inserts a draft that a
  // 4xx answer would then commit.
  const clearingId = await getSystemAccountId('vat_input_late_claim', companyId);
  const bases = lateClaimBases(facts); // same lines, same order: the input-VAT debits
  const taxLines = lines
    .filter((l, i) => canonicalSubtype(facts[i]!.accountSubtype) === 'vat_input' && Number(l.debit) > 0)
    .map((l, k) => ({
      id: l.id, glAccountId: l.glAccountId, amount: Number(l.debit), vatType: l.vatType ?? null, base: bases[k] ?? 0,
    }));
  return { lock, clearingId, claimDate, inputTax: verdict.inputTax, taxLines };
}
