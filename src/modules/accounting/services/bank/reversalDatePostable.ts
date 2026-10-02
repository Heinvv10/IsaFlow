/**
 * `reverseReconciledTransaction`'s pre-write check that its contra can post.
 * Moved out of bankAllocationService.ts unchanged apart from `export`
 * (R-127, file-size cap).
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { resolveReversalDate } from '../gl/journalEntryService';
import { getPeriodStatusForDate } from '../gl/periodStatusService';
import { loadJournalVatLines } from '../gl/journalVatLockGuard';
import { findJournalChainHead, lockChainHead } from '../shared/journalChainHead';
import { BankAllocationRefusal } from './bankAllocationRefusal';

type Row = DbRow;

/**
 * Refuse a reversal whose contra could never post — BEFORE the unwind writes.
 *
 * `resolveReversalDate` checks an EXPLICIT reversal_date, but its default arm
 * falls back to today without checking that today's period is open. That
 * fallback is the reachable trigger: `postJournalEntry` then raises
 * `ClosedFiscalPeriodError` several writes after `unwindBankAllocationApplication`
 * has already reopened the invoice and deleted the allocation rows, and the
 * route answers 400 — which `withAuth` COMMITs, because it only ROLLBACKs on
 * `statusCode >= 500`. Checking the resolved date here turns that corrupting
 * 400 into an honest refusal that has written nothing.
 */
export async function assertReversalDatePostable(
  companyId: string, journalEntryId: string, requested: string | undefined,
): Promise<void> {
  const rows = (await sql`
    SELECT entry_date FROM gl_journal_entries
    WHERE id = ${journalEntryId}::UUID AND company_id = ${companyId}::UUID`) as Row[];
  if (rows.length === 0) throw new Error('Cannot reverse: journal entry not found');
  const originalDate = fmtDate(rows[0]!.entry_date as string | Date);
  // With the journal's lines, so a locked VAT period rolls the date (or
  // refuses, pre-write) exactly as reverseJournalEntry will.
  const reversalDate = await resolveReversalDate(
    companyId, originalDate, requested, await loadJournalVatLines(companyId, journalEntryId));
  const status = await getPeriodStatusForDate(companyId, reversalDate);
  // `closed` ONLY — `no_period` is deliberately allowed through. createJournalEntry
  // calls ensureFiscalPeriodForDate, which CREATES the fiscal year on demand for
  // any year inside the auto-create window, and the only uncovered date that can
  // reach here is today: resolveReversalDate has already proven an explicit date
  // open, and its default arm returns an open original date, an original date
  // whose year posting will create (R-012), or today.
  // Today is always inside that window, so refusing here would turn a reversal
  // that used to auto-create its year into a 400 — the one outcome
  // fiscalPeriodAutoCreate.ts was written to avoid. A guard fronting a write must
  // refuse only what the write itself refuses.
  if (status !== 'closed') return;
  // getPeriodStatusForDate reports 'closed' for a LOCKED period too, so the
  // message names both rather than telling someone to re-open a locked period.
  throw new Error(
    `Cannot reverse: the fiscal period covering ${reversalDate} is not open (closed or locked). `
    + 'Re-open it before reversing.',
  );
}

/**
 * D8: the entry a reversal of `journalEntryId` must post against, or null for
 * none. Its reversal chain's HEAD (locked) while that chain stands — after
 * O <- R <- R2 the GL carries O again through R2 while O is stamped reversed,
 * and reversing O throws "already reversed". NULL when the chain is already
 * OUT (a real posted contra stands against it): the allocation is freed and
 * nothing is reversed, as every other D8 flow does (round 4). A broken chain —
 * stamped reversed with no posted contra, the shape k021 forges — returns the
 * journal itself, and reverseJournalEntry refuses it inside the caller's
 * savepoint exactly as before.
 */
export async function reversalTargetOf(companyId: string, journalEntryId: string): Promise<string | null> {
  const chain = await findJournalChainHead(companyId, journalEntryId);
  if (chain?.kind !== 'head') return journalEntryId;
  const head = await lockChainHead(companyId, journalEntryId);
  return head?.standing ? head.id : null;
}

/** `reversalTargetOf` from the unlocked walk alone: the pre-write answer, before any row of the caller is locked. */
export async function peekReversalTarget(companyId: string, journalEntryId: string): Promise<string | null> {
  const chain = await findJournalChainHead(companyId, journalEntryId);
  if (chain?.kind !== 'head') return journalEntryId;
  return chain.standing ? chain.id : null;
}

/**
 * The target again, its head LOCKED — called after the caller has locked its documents, so the journal is
 * locked last, as every flow locks it (document, then head: D8 round 6, brk-d8b F2 — the head locked before
 * the unwind deadlocked against a receipt cancel). Refuses when it moved since `peekReversalTarget`.
 */
export async function lockPeekedReversalTarget(
  companyId: string, journalEntryId: string, peeked: string | null,
): Promise<void> {
  if (await reversalTargetOf(companyId, journalEntryId) !== peeked) {
    throw new BankAllocationRefusal(
      "This bank line's journal was reversed by another request while this was in progress — retry in a moment.");
  }
}

/** A journal's entry_date, as pg returns it (Date or string). */
export async function entryDateOf(companyId: string, journalEntryId: string): Promise<unknown> {
  const [row] = (await sql`SELECT entry_date FROM gl_journal_entries
    WHERE id = ${journalEntryId}::UUID AND company_id = ${companyId}::UUID`) as Row[];
  return row?.entry_date ?? null;
}
