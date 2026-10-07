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
import { fmtDate } from '@/lib/fmtDate';
import { createJournalEntry, getJournalEntryById } from './journalEntryCrudService';
import { resolveReversalDateDetailed, type VatLockRoll } from './journalEntryReversalDate';
import { assertJournalVatPeriodOpen, loadJournalVatLines } from './journalVatLockGuard';
import type { JournalEntryMeta } from './journalEntryMeta';
import { planLockedVatPosting, type LateClaimInfo, type LateClaimPlan } from './vatLateClaimPlan';
import { isMarkedUnderEnforcement } from './manualJournalApproval';

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

async function applyLateClaimSplit(
  companyId: string,
  entry: JournalEntry,
  plan: LateClaimPlan,
  userId: string,
  hooks: SplitHooks,
): Promise<JournalEntry & { lateClaim: LateClaimInfo }> {
  return withSavepoint('vat_late_claim', async () => {
    const { clearingId } = plan;
    const taxLineIds = plan.taxLines.map((t) => t.id).filter((v): v is string => Boolean(v));
    if (taxLineIds.length !== plan.taxLines.length) throw new Error('Late claim: the draft\'s tax lines have no ids');

    // R-035 PR6: a MARKED manual journal under manual-journal enforcement posts
    // FIRST, with its lines as drafted — what its approval vouched for, and
    // what migration 869's backstop judges as it enters 'posted'; steps 1-3
    // then rewrite the posted lines (the balance trigger re-files them), all
    // in this savepoint. Every other journal keeps the order below exactly.
    const approvedFirst = (await isMarkedUnderEnforcement(companyId, entry.id)) ? await hooks.postOriginal() : null;

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
    const posted = approvedFirst ?? await hooks.postOriginal();

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
    await writeLateClaimBases(companyId, companion.id, plan.taxLines);

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

/**
 * A companion is reversed WITH its original, never alone: reversing it by
 * itself would put the claimed VAT back on the clearing account with nothing
 * left to clear it. Code-less, so every route and the MCP boundary surface the
 * message as the caller's refusal.
 */
export class LateClaimCompanionReversalError extends Error {
  constructor(entryNumber: string) {
    super(`${entryNumber} is the late input-VAT claim of another journal and cannot be reversed on its own. `
      + 'Reverse the original journal (or cancel its document): its late claim is reversed with it.');
    this.name = 'LateClaimCompanionReversalError';
  }
}

export interface CompanionReversalPlan {
  id: string;
  entryNumber: string;
  /** The companion's own default reversal date, rolled past any locked VAT period. */
  reversalDate: string;
  vatLockRoll: VatLockRoll | null;
}

/**
 * The posted, unreversed late-claim companion of `originalId`, and the date its
 * reversal will take — resolved exactly as reverseJournalEntry will, BEFORE
 * any write, so a companion that cannot be reversed refuses the original's
 * reversal (and a bill cancel) while nothing has been written. Null when the
 * journal has no live companion.
 */
export async function planLateClaimCompanionReversal(
  companyId: string, originalId: string,
): Promise<CompanionReversalPlan | null> {
  const [row] = (await sql`
    SELECT id FROM gl_journal_entries
    WHERE company_id = ${companyId}::UUID AND late_claim_of_id = ${originalId}::UUID
      AND status = 'posted' AND reversed_at IS NULL`) as Row[];
  if (!row) return null;
  const companion = await getJournalEntryById(companyId, String(row.id));
  if (!companion) return null;
  const { date, vatLockRoll } = await resolveReversalDateDetailed(
    companyId, fmtDate(companion.entryDate), undefined, companion.lines);
  return { id: companion.id, entryNumber: companion.entryNumber, reversalDate: date, vatLockRoll };
}

/**
 * The base behind each claim, on its companion line, so the claim period's 15%
 * check counts it. Lines with the same account, code and amount are
 * interchangeable (their bases differ by the rounding cent at most).
 *
 * EVERY planned line must take its base: a line left NULL would be an entry
 * without base in the claim period and its claim would escape the check. A
 * mismatch is a FAULT, not a refusal — a plain Error, so the route answers 5xx
 * and the split's savepoint rolls the whole claim back.
 */
export async function writeLateClaimBases(
  companyId: string, companionId: string,
  taxLines: readonly { glAccountId: string; amount: number; vatType: string | null; base: number }[],
): Promise<void> {
  let written = 0;
  for (const t of taxLines) {
    const rows = (await sql`
      UPDATE gl_journal_lines SET late_claim_base = ${t.base}
      WHERE id = (
        SELECT id FROM gl_journal_lines
        WHERE company_id = ${companyId}::UUID AND journal_entry_id = ${companionId}::UUID
          AND gl_account_id = ${t.glAccountId}::UUID AND debit = ${t.amount}
          AND vat_type IS NOT DISTINCT FROM ${t.vatType}::TEXT AND late_claim_base IS NULL
        ORDER BY id LIMIT 1)
        AND company_id = ${companyId}::UUID
      RETURNING id`) as Row[];
    written += rows.length;
  }
  if (written !== taxLines.length) {
    throw new Error(`Late claim ${companionId}: the base was written on ${written} of ${taxLines.length} `
      + 'VAT Input lines; the claim is rolled back.');
  }
}

/**
 * A companion's reversal carries each claim's base NEGATED, so the claim and
 * its reversal net to nothing in the 15% check too. Lines pair up by account,
 * code and amount (the contra's credit is the companion's debit). Every
 * companion line with a base must find its partner, or the reversal would
 * leave a claim's base standing: a plain Error (fault → the reversal rolls back).
 */
export async function copyLateClaimBaseToReversal(
  companyId: string, companionId: string, reversalId: string,
): Promise<void> {
  const [c] = (await sql`
    SELECT COUNT(*)::INT AS n FROM gl_journal_lines
    WHERE company_id = ${companyId}::UUID AND journal_entry_id = ${companionId}::UUID
      AND late_claim_base IS NOT NULL`) as Row[];
  const expected = Number(c?.n ?? 0);
  const copied = (await sql`
    WITH o AS (
      SELECT late_claim_base, gl_account_id, COALESCE(vat_type, '') AS vt, debit AS amt,
             ROW_NUMBER() OVER (PARTITION BY gl_account_id, COALESCE(vat_type, ''), debit ORDER BY id) AS rn
      FROM gl_journal_lines
      WHERE company_id = ${companyId}::UUID AND journal_entry_id = ${companionId}::UUID
        AND late_claim_base IS NOT NULL
    ), r AS (
      SELECT id, gl_account_id, COALESCE(vat_type, '') AS vt, credit AS amt,
             ROW_NUMBER() OVER (PARTITION BY gl_account_id, COALESCE(vat_type, ''), credit ORDER BY id) AS rn
      FROM gl_journal_lines
      WHERE company_id = ${companyId}::UUID AND journal_entry_id = ${reversalId}::UUID
    )
    UPDATE gl_journal_lines l SET late_claim_base = -o.late_claim_base
    FROM o JOIN r USING (gl_account_id, vt, amt, rn)
    WHERE l.id = r.id AND l.company_id = ${companyId}::UUID
    RETURNING l.id`) as Row[];
  if (copied.length !== expected) {
    throw new Error(`Reversal ${reversalId} of late claim ${companionId}: the base was carried to `
      + `${copied.length} of ${expected} lines; the reversal is rolled back.`);
  }
}
