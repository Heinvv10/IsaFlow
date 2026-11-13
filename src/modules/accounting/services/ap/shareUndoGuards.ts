/**
 * The refusals `shareUndoPlan.ts` makes once the undo journals are drafted (void_payment undo_share, step 6). Reads
 * only, inside the void's pre-write hook; each throws ShareUndoRefusal, which writes nothing.
 *
 * ── CAPACITY IS CUMULATIVE (review round 1, breaker REPRO 1 + 4) ────────────
 * A share journal took a FIXED amount out of the clearing account X: its debit on X, and its credits on each expense
 * and VAT account. Every undo gives some of that back — the ones void_payment linked to it (`source_record_id`) AND
 * every hand undo attributed to it (rounds 2-3: a journal in the share's month crediting X and debiting the share's
 * accounts, netted over its reversal chain; `shareUndoHandUndos.ts` says which). So an undo is allowed only while the
 * share still holds it:
 *     share DR X  −  Σ earlier undos' CR X  −  this undo's total  ≥ 0, and the same per expense / VAT account.
 * Without it one share could be undone by two different contras, by the same bill's next contra after a void, or by
 * void_payment on top of a person's hand undo. Nothing is refused for LOOKING like a hand undo (round 1 did that, and
 * same-shape bills made it refuse the wrong one): a hand undo simply uses capacity.
 * The share head is locked FOR UPDATE first (`lockShareJournal`), so two undos against one share serialise.
 */
import { formatMoney } from '@/lib/money/formatMoney';
import { fmtDate } from '@/lib/fmtDate';
import { getPeriodStatusForDate } from '../gl/periodStatusService';
import { findActiveVatLock, journalMovesVatFigure } from '../gl/journalVatLockGuard';
import { assertNoHeaderAccountLines } from '../gl/headerAccountGuard';
import { toCents } from './billAllocatable';
import { ShareUndoRefusal, type ShareUndoJournalPlan } from './shareUndoTypes';
import { readAccountCode, readShareConsumption, type JournalHead, type JournalLineRow } from './shareUndoReads';

const cents = (n: number) => toCents(n);

/** The share still holds every amount this undo gives back (header: cumulative). */
export async function assertShareCapacity(
  companyId: string, share: JournalHead, shareLines: readonly JournalLineRow[], x: JournalLineRow,
  journals: readonly ShareUndoJournalPlan[],
): Promise<void> {
  const name = share.entryNumber ?? share.id;
  const { byAccount: consumed, handUndos } = await readShareConsumption(companyId, share.id, x.glAccountId);
  const named = handUndos.slice(0, 10).join(', ') + (handUndos.length > 10 ? ` and ${handUndos.length - 10} more` : '');
  const byHand = handUndos.length > 0 ? ` (including hand journal${handUndos.length === 1 ? '' : 's'} ${named})` : '';
  const sum = (account: string, side: 'debit' | 'credit') =>
    shareLines.filter((l) => l.glAccountId === account).reduce((s, l) => s + cents(l[side]), 0);
  const total = journals.reduce((s, j) => s + cents(j.amount), 0);
  const leftOnX = sum(x.glAccountId, 'debit') - (consumed.get(x.glAccountId)?.credit ?? 0);
  if (leftOnX < total) {
    throw new ShareUndoRefusal(`Share journal ${name} does not hold the ${formatMoney(total / 100)} being undone on `
      + `${x.accountCode ?? x.glAccountId} ${x.accountName ?? ''} (the account this payment credits): it debited `
      + `${formatMoney(sum(x.glAccountId, 'debit') / 100)} there and earlier undos gave back `
      + `${formatMoney((consumed.get(x.glAccountId)?.credit ?? 0) / 100)}${byHand} — it is not (or no longer) the share of `
      + 'these bills.');
  }
  const need = new Map<string, number>();
  for (const l of journals.flatMap((j) => j.lines)) if (l.debit > 0) need.set(l.glAccountId, (need.get(l.glAccountId) ?? 0) + cents(l.debit));
  for (const [account, want] of need) {
    const left = sum(account, 'credit') - (consumed.get(account)?.debit ?? 0);
    if (left < want) {
      throw new ShareUndoRefusal(`Share journal ${name} does not hold the ${formatMoney(want / 100)} the bills posted to `
        + `account ${await readAccountCode(companyId, account)}: it credited ${formatMoney(sum(account, 'credit') / 100)} `
        + `there and earlier undos gave back ${formatMoney((consumed.get(account)?.debit ?? 0) / 100)}${byHand} — it is `
        + 'not (or no longer) the share of these bills.');
    }
  }
}

/** The share's date takes the undo as it is: an open period, outside any VAT lock. Never rolled. */
export async function assertDateOpen(companyId: string, date: string, journals: readonly ShareUndoJournalPlan[]): Promise<void> {
  if ((await getPeriodStatusForDate(companyId, date)) !== 'open') {
    throw new ShareUndoRefusal(`The undo is dated on the share journal's date, ${date}, which is not in an open fiscal `
      + 'period — re-open it first (it is never rolled to another date).');
  }
  const lock = await findActiveVatLock(companyId, date);
  if (lock && await journalMovesVatFigure(companyId, journals.flatMap((j) => j.lines))) {
    throw new ShareUndoRefusal(`The undo is dated on the share journal's date, ${fmtDate(date)}, inside the locked VAT `
      + `period ${lock.periodStart} to ${lock.periodEnd}, and it moves input VAT — unlock the period first (it is `
      + 'never rolled to another date).');
  }
}

/**
 * Every account the undo posts to can take a posting: active (postJournalEntry would refuse it AFTER the void, as an
 * untyped error) and not a header (createJournalEntry's D1 rule, run here from reads).
 */
export async function assertAccountsPostable(
  companyId: string, legsByAccount: ReadonlyMap<string, JournalLineRow>, journals: readonly ShareUndoJournalPlan[],
): Promise<void> {
  for (const l of journals.flatMap((j) => j.lines)) {
    const row = legsByAccount.get(l.glAccountId);
    if (row && !row.accountActive) {
      throw new ShareUndoRefusal(`Account ${row.accountCode ?? row.glAccountId} is deactivated, so the undo cannot post `
        + 'to it — re-activate it first.');
    }
  }
  await assertNoHeaderAccountLines(companyId, journals.flatMap((j) => j.lines));
}
