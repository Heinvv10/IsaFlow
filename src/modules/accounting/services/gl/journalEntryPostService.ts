/** Post a draft journal: balance, period, inactive-account and VAT-lock guards, then status → posted. */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { withAlsTransaction } from '@/lib/alsTransaction';
import { validateJournalEntry } from '../../utils/doubleEntry';
import type { JournalEntry } from '../../types/gl.types';
import { getJournalEntryById, resolveUserUuid, mapEntryRow } from './journalEntryCrudService';
import { assertJournalVatPeriodOpen } from './journalVatLockGuard';
import { ClosedFiscalPeriodError, assertNoInactiveAccountLines } from './journalEntryPostingGuards';
import type { LateClaimInfo, PostJournalOpts } from './vatLateClaimPlan';
import { postSplitIfLateClaim } from './vatLateClaimSplit';
import { assertJournalDocumentsPostable } from '../shared/documentCurrency';

type Row = DbRow;

/** `opts.allowLateInputClaim`: a human-initiated caller opts in to the s16(3) split (vatLateClaimPlan.ts). */
export async function postJournalEntry(
  companyId: string, id: string, userId: string, opts?: PostJournalOpts,
): Promise<JournalEntry & { lateClaim?: LateClaimInfo }> {
  const late = opts?.allowLateInputClaim === true;
  // Opted in: one transaction for the header lock, the plan and the split.
  const run = () => postJournalEntryInner(companyId, id, userId, late);
  return late ? withAlsTransaction({ companyId, userId }, run) : run();
}

async function postJournalEntryInner(
  companyId: string, id: string, userId: string, allowLateInputClaim: boolean,
): Promise<JournalEntry & { lateClaim?: LateClaimInfo }> {
  try {
    // Lock the header BEFORE reading it: the VAT-lock guard below decides on
    // entry_date, and a concurrent edit of the draft's date must not land
    // between that decision and the status UPDATE.
    await sql`SELECT id FROM gl_journal_entries WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID FOR UPDATE`;
    const entry = await getJournalEntryById(companyId, id);
    if (!entry) throw new Error(`Journal entry ${id} not found`);
    if (entry.status !== 'draft') throw new Error(`Cannot post entry with status: ${entry.status}`);

    if (entry.fiscalPeriodId) {
      const period = (await sql`
        SELECT status FROM fiscal_periods
        WHERE id = ${entry.fiscalPeriodId} AND company_id = ${companyId}::UUID
      `) as Row[];
      if (period.length > 0 && String(period[0]!.status) !== 'open') {
        throw new ClosedFiscalPeriodError(String(period[0]!.status));
      }
    }

    if (entry.lines) {
      const validation = validateJournalEntry(entry.lines.map(l => ({
        glAccountId: l.glAccountId,
        debit: l.debit,
        credit: l.credit,
      })));
      if (!validation.valid) throw new Error(`Entry not balanced: ${validation.errors.join('; ')}`);
    }

    // A deactivated account must not accept a new posting. is_active means the
    // account has been withdrawn from the chart, so posting to it contradicts
    // the flag outright -- and it is the one route by which an account can end
    // up inactive AND holding money despite the balance guard on
    // updateAccount/deleteAccount: deactivate while only drafts exist (balance
    // 0, correctly allowed), then post the draft.
    //
    // Refuse the WHOLE entry. Skipping the offending line would leave the
    // journal unbalanced, and the refusal has to land before the UPDATE so the
    // surrounding transaction commits nothing (the 400-after-write class).
    await assertNoInactiveAccountLines(companyId, id);
    // FX PR0: a draft journal a foreign document links to, posted by hand
    // while the company has not enabled them. Before the UPDATE, too.
    await assertJournalDocumentsPostable(companyId, id);

    const markPosted = async (): Promise<JournalEntry> => {
      const safePostUserId = await resolveUserUuid(userId);
      const rows = (await sql`
        UPDATE gl_journal_entries
        SET status = 'posted', posted_by = ${safePostUserId}::UUID, posted_at = NOW()
        WHERE id = ${id} AND company_id = ${companyId}
        RETURNING *
      `) as Row[];
      log.info('Posted journal entry', { id, entryNumber: String(rows[0]!.entry_number) }, 'accounting');
      return mapEntryRow(rows[0]!);
    };
    // An opted-in caller gets the s16(3) late input-VAT claim instead of the
    // lock refusal where the law allows it (vatLateClaimSplit.ts).
    const split = allowLateInputClaim ? await postSplitIfLateClaim(companyId, entry, userId, {
      postOriginal: markPosted, post: (draftId) => postJournalEntry(companyId, draftId, userId),
    }) : null;
    if (split) return split;
    // A journal that moves a VAT-return figure may not post inside a locked
    // (filed) VAT period. Before the UPDATE, like the two refusals above, and
    // it takes the shared advisory lock a VAT lock's figure snapshot excludes.
    // Reversals reach here with a date already rolled past any lock.
    await assertJournalVatPeriodOpen(companyId, entry.entryDate, entry.lines ?? []);
    return await markPosted();
  } catch (err) {
    log.error('Failed to post journal entry', { id, error: err }, 'accounting');
    throw err;
  }
}

