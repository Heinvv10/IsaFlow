/**
 * The writing side of a LATE INPUT-VAT CLAIM (VAT Act s16(3)); the decision is
 * vatLateClaimPlan.ts.
 *
 * A draft dated inside a locked VAT period, whose only VAT is input tax, posts
 * as two journals:
 *
 *   ORIGINAL  (its own date, in the filed period) — every line as drafted,
 *             except each VAT Input line moves onto the "Input VAT - late
 *             claims" clearing account, and every VAT code comes off. It is then
 *             in no box of the filed return, so the lock lets it post and the
 *             filed figures do not move.
 *   COMPANION (the first day after the lock) — DR VAT Input, one line per
 *             original tax line carrying its VAT code (so the VAT201 box is
 *             kept), CR clearing. Source `auto_vat_late_claim`,
 *             `late_claim_of_id` → the original. No source_record_id or
 *             source_document_id: the document still points at the original.
 *
 * The clearing account nets to zero once both are posted.
 *
 * All of it runs in one savepoint inside the caller's transaction (or one of
 * its own outside a request), so a failure anywhere leaves the draft exactly as
 * it was.
 */
import { sql, withSavepoint } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { JournalEntry } from '../../types/gl.types';
import { createJournalEntry } from './journalEntryCrudService';
import { assertJournalVatPeriodOpen, loadJournalVatLines } from './journalVatLockGuard';
import { getSystemAccountId } from './systemAccountResolver';
import type { JournalEntryMeta } from './journalEntryMeta';
import { planLockedVatPosting, type LateClaimInfo, type LateClaimPlan } from './vatLateClaimPlan';

type Row = Record<string, unknown>;

export interface SplitHooks {
  /** Flip the (now VAT-free) original to posted; the posting service's own UPDATE. */
  postOriginal: () => Promise<JournalEntry>;
  /** Post a draft through the ordinary, non-opted-in path. */
  post: (id: string) => Promise<JournalEntry>;
}

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** The companion's stamp: whoever posted the original posted this too. */
async function originalMeta(companyId: string, id: string): Promise<JournalEntryMeta> {
  const [h] = (await sql`
    SELECT posting_agent, actor_type, actor_token_jti FROM gl_journal_entries
    WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID`) as Row[];
  return {
    postingAgent: String(h?.posting_agent ?? 'human'),
    ...(h?.actor_type == null ? {} : { actorType: h.actor_type as JournalEntryMeta['actorType'] }),
    ...(h?.actor_token_jti == null ? {} : { actorTokenJti: String(h.actor_token_jti) }),
  };
}

/**
 * The opted-in post: null when the draft is not inside a lock (or moves no VAT
 * figure) — post it normally — else the split, or the planner's refusal.
 */
export async function postSplitIfLateClaim(
  companyId: string, entry: JournalEntry, userId: string, hooks: SplitHooks,
): Promise<(JournalEntry & { lateClaim: LateClaimInfo }) | null> {
  const plan = await planLockedVatPosting(companyId, entry.entryDate, entry.lines ?? []);
  return plan ? applyLateClaimSplit(companyId, entry, plan, userId, hooks) : null;
}

export async function applyLateClaimSplit(
  companyId: string,
  entry: JournalEntry,
  plan: LateClaimPlan,
  userId: string,
  hooks: SplitHooks,
): Promise<JournalEntry & { lateClaim: LateClaimInfo }> {
  return withSavepoint('vat_late_claim', async () => {
    const clearingId = await getSystemAccountId('vat_input_late_claim', companyId);
    const taxLineIds = plan.taxLines.map((t) => t.id).filter((v): v is string => Boolean(v));
    if (taxLineIds.length !== plan.taxLines.length) throw new Error('Late claim: the draft\'s tax lines have no ids');

    // 1. The original's input VAT onto the clearing account.
    await sql`
      UPDATE gl_journal_lines SET gl_account_id = ${clearingId}::UUID, vat_type = NULL
      WHERE company_id = ${companyId}::UUID AND journal_entry_id = ${entry.id}::UUID
        AND id = ANY(${taxLineIds}::UUID[])`;
    // 2. Every VAT code off the original: a coded base line still moves a box.
    await sql`
      UPDATE gl_journal_lines SET vat_type = NULL
      WHERE company_id = ${companyId}::UUID AND journal_entry_id = ${entry.id}::UUID
        AND vat_type IS NOT NULL AND vat_type <> 'no_vat'`;
    // 3. The lock guard, on the lines as they now stand: the original must be
    //    in no box of the filed return, or it may not post.
    await assertJournalVatPeriodOpen(companyId, entry.entryDate, await loadJournalVatLines(companyId, entry.id));
    const posted = await hooks.postOriginal();

    // 4. The companion, on the claim date.
    const total = r2(plan.taxLines.reduce((s, t) => s + t.amount, 0));
    const companion = await createJournalEntry(companyId, {
      entryDate: plan.claimDate,
      description: `Late input VAT claim for ${posted.entryNumber} (${entry.entryDate}, VAT period `
        + `${plan.lock.periodStart} to ${plan.lock.periodEnd} was filed)`,
      source: 'auto_vat_late_claim',
      reference: posted.entryNumber,
      lines: [
        ...plan.taxLines.map((t) => ({
          glAccountId: t.glAccountId, debit: t.amount, credit: 0,
          description: `Input VAT claimed late (s16(3)) — ${posted.entryNumber}`,
          ...(t.vatType ? { vatType: t.vatType as never } : {}),
        })),
        { glAccountId: clearingId, debit: 0, credit: total, description: `Clear late claim — ${posted.entryNumber}` },
      ],
    }, userId, await originalMeta(companyId, entry.id));
    await hooks.post(companion.id);
    await sql`
      UPDATE gl_journal_entries SET late_claim_of_id = ${entry.id}::UUID
      WHERE id = ${companion.id}::UUID AND company_id = ${companyId}::UUID`;

    const lateClaim: LateClaimInfo = {
      claimDate: plan.claimDate,
      lockPeriod: { start: plan.lock.periodStart, end: plan.lock.periodEnd },
      companionEntryId: companion.id,
      companionEntryNumber: companion.entryNumber,
      inputTax: total,
      message: `${posted.entryNumber} is dated ${entry.entryDate}, inside the VAT period `
        + `${plan.lock.periodStart} to ${plan.lock.periodEnd}, whose VAT201 has been filed. Its input VAT of `
        + `R${total.toFixed(2)} is claimed on ${plan.claimDate} instead (${companion.entryNumber}), in the next open `
        + 'VAT period, as VAT Act s16(3) allows.',
    };
    log.info('Late input VAT claim split', { originalId: entry.id, companionId: companion.id, ...lateClaim }, 'accounting');
    return { ...posted, lateClaim };
  });
}
