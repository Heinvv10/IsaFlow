import {isAuthorizedHistoricalPosting} from '../controls/historicalPostingGuard';
/** Shared journal writers: authenticated control gate before any financial effect. */
import { randomUUID } from 'node:crypto';
import { sql, type DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { JournalEntry } from '../../types/gl.types';
import { mapEntryRow } from './journalEntryCrudService';
import { defaultHumanMeta, actorMeta, type PostingActorOpts } from './journalEntryMeta';
import { runJournalControl, type JournalControlOptions } from './journalControlService';
import { registerGeneratedJournal } from '../controls/generatedJournalPermit';
import type { ApMaterial } from '../controls/apOperationMaterializer';
import { isAuthorizedYearEndPosting } from '../controls/yearEndPostingGuard';
import { postingPeriodBlock, throwPostingBlock } from './postingPeriodGuard';
import { releaseCapturedDocumentPostingClaim } from '../capture/capturePostingClaimRelease';
import type { ReversalEntry } from './reversalLines';
// The typed refusal, not the plain Error: pages/api/accounting/soft-delete.ts decides 400-vs-500
// on the class. `journalReversalDate.ts` is the untyped predecessor and no longer read from here.
export { resolveReversalDate, ReversalPeriodError } from './journalEntryReversalDate';
export type { ReversalEntry } from './reversalLines';
export type { JournalControlOptions } from './journalControlService';
export { GeneratedJournalOperationError } from './journalControlService';
export { ClosedFiscalPeriodError, isPostingRefusal } from './postingPeriodGuard';
type Row = DbRow;
export class InactiveAccountError extends Error {
  readonly accounts: string[];
  constructor(accounts: { code: string; name: string }[]) {
    super(`Cannot post to deactivated GL account${accounts.length === 1 ? '' : 's'}: ${accounts.map(a => `${a.code} ${a.name}`).join(', ')}. Reactivate the account, or recode the line to an active one.`);
    this.name = 'InactiveAccountError'; this.accounts = accounts.map(a => a.code);
  }
}
/** Kept for legacy direct writers; the controlled posting path locks and validates the complete population. */
export async function assertNoInactiveAccountLines(companyId: string, entryId: string): Promise<void> {
  const rows = await sql`SELECT DISTINCT ga.account_code,ga.account_name FROM gl_journal_lines jl
    JOIN gl_accounts ga ON ga.id=jl.gl_account_id AND ga.company_id=jl.company_id
    WHERE jl.journal_entry_id=${entryId} AND jl.company_id=${companyId}::uuid AND ga.is_active=false
    ORDER BY ga.account_code` as Row[];
  if (rows.length) throw new InactiveAccountError(rows.map(r => ({ code: String(r.account_code), name: String(r.account_name) })));
}
function facts(material: ApMaterial): { header: Row; targetPeriod: Row; company: Row; accounts: Row[]; vatLocks: Row[] } {
  return material.observedSources.find(s => s.entityType === 'journal_entry' && s.entityId === material.binding.entityId)!.facts as
    { header: Row; targetPeriod: Row; company: Row; accounts: Row[]; vatLocks: Row[] };
}
/**
 * `authorizedYearEndSweep` ALSO waives the inactive-account refusal, and it is the
 * only caller that may.
 *
 * A withdrawn P&L account can still be carrying a balance — it was deactivated
 * after it was used — and the year-end sweep is the one operation whose whole
 * purpose is to zero it into equity. Refusing the line does not protect anything:
 * the balance exists either way, and the account cannot be cleared without the
 * close nor closed without being reactivated first, so the year can never close
 * again, every year, forever. `yearEndJournalPoster.postClosingJournal` has
 * documented and honoured that exemption since the close was written; routing the
 * controlled close through this function silently took it away.
 *
 * It is safe because the authority is narrow, not because the sweep is trusted:
 * `isAuthorizedYearEndPosting` proves the parent operation is THIS year's close,
 * that the permit registry issued a `journal.post` permit for THIS journal, and
 * that the header is the draft `YE-<year>` `year_end` row landing on the year's
 * own last period. Nothing else can reach it — the historical-posting authority
 * is deliberately NOT OR'd in here, only into the closed-period waiver, because
 * back-dating a correction is no reason to post at a withdrawn account. The
 * equity side needs no exemption and gets none: `systemAccountResolver` caches
 * only `is_active = true` accounts, so an inactive retained-earnings account
 * surfaces as `no_retained_earnings` long before this point.
 */
function assertPostingGuards(material: ApMaterial, authorizedClosedPeriod = false,
  authorizedYearEndSweep = false): ReturnType<typeof facts> {
  const state = facts(material);
  throwPostingBlock(postingPeriodBlock(state.targetPeriod.status, state.company, material.binding.accountingDate!, authorizedClosedPeriod),
    state.vatLocks.length > 0);
  const inactive = authorizedYearEndSweep ? [] : state.accounts.filter(a => a.is_active !== true);
  if (inactive.length) throw new InactiveAccountError(inactive.map(a => ({ code: String(a.account_code), name: String(a.account_name) })));
  return state;
}
export async function postJournalEntry(companyId: string, id: string, userId: string, opts?: JournalControlOptions): Promise<JournalEntry> {
  return runJournalControl(companyId, userId, { entityType: 'journal_entry', entityId: id, operation: 'journal.post' }, opts,
    async (ctx, material, parent) => {
      const state = facts(material);
      const yearEndSweep = isAuthorizedYearEndPosting(ctx, parent, state.header, state.targetPeriod, material.binding.accountingDate!);
      const authorizedClosedPeriod = yearEndSweep
        ||isAuthorizedHistoricalPosting(ctx,parent,state.header,state.targetPeriod,material.binding.accountingDate!);
      const { header } = assertPostingGuards(material, authorizedClosedPeriod, yearEndSweep);
      if (header.status !== 'draft') throw new Error(`Cannot post entry with status: ${header.status}`);
      const rows = await ctx.sql`UPDATE gl_journal_entries SET status='posted',posted_by=${ctx.principal.personId}::uuid,posted_at=clock_timestamp()
        WHERE company_id=${companyId}::uuid AND id=${id}::uuid AND status='draft' RETURNING *` as Row[];
      if (rows.length !== 1) throw new Error('Journal posting state changed');
      log.info('Posted journal entry', { id }, 'accounting');
      // Legacy mapper uses undefined for absent optional API fields; omit them from the durable JSON result.
      return Object.fromEntries(Object.entries(mapEntryRow(rows[0]!)).filter(([, value]) => value !== undefined)) as unknown as JournalEntry;
    });
}
/** Contra lines are copied in SQL, retaining exact cents and every classification without Number conversion. */
export async function reverseJournalEntry(companyId: string, id: string, userId: string,
  opts?: PostingActorOpts & JournalControlOptions & { reversalDate?: string }): Promise<ReversalEntry> {
  const ref = { entityType: 'journal_entry', entityId: id, operation: 'journal.reverse' as const,
    ...(opts?.reversalDate === undefined ? {} : { reversalDate: opts.reversalDate }) };
  return runJournalControl(companyId, userId, ref, opts, async (ctx, material, parentControl) => {
    const { header, targetPeriod } = assertPostingGuards(material);
    if (header.status !== 'posted') throw new Error('Can only reverse posted entries');
    if (header.reversed_at) throw new Error('Journal entry already reversed');
    const contraId = randomUUID(), meta = actorMeta(opts) ?? defaultHumanMeta(ctx.principal.personId);
    const sourceRecord = parentControl.parent.entityType === 'journal_entry' ? null : parentControl.parent.entityId;
    const rows = await ctx.sql`INSERT INTO gl_journal_entries(id,company_id,entry_date,fiscal_period_id,description,source,
      source_record_id,reversal_of_id,created_by,posting_agent,source_document_hash,extraction_confidence,actor_type,actor_token_jti)
      VALUES(${contraId}::uuid,${companyId}::uuid,${material.binding.accountingDate}::date,${String(targetPeriod.id)}::uuid,
        ${`Reversal of ${id}`},${header.source},${sourceRecord}::uuid,${id}::uuid,${ctx.principal.personId}::uuid,
        ${meta.postingAgent},${meta.sourceDocumentHash ?? null},${meta.extractionConfidence ?? null},${meta.actorType ?? null},${meta.actorTokenJti ?? null}) RETURNING *` as Row[];
    if (rows.length !== 1) throw new Error('Reversal journal could not be created');
    // A legacy posted line can hold a project/cost-centre/CC1/CC2/business-unit id belonging to
    // another company. Copying it forward is not available — migration 664's composite FK refuses
    // the contra row — and refusing the reversal would leave the entry permanently un-correctable,
    // reversal being the only correction this schema has. So the foreign id is dropped, per line
    // and per dimension, exactly as reversalLines.ts does it on the legacy path; an OWNED id
    // (inactive or not) still comes across, and vat_type is a classification with no owning row so
    // it always does. Counted first, because the JOIN that drops them cannot report what it lost.
    const [dropped] = await ctx.sql`SELECT COUNT(*)::int AS n FROM gl_journal_lines l
      WHERE l.company_id=${companyId}::uuid AND l.journal_entry_id=${id}::uuid
        AND ((l.project_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM projects p WHERE p.id=l.project_id AND p.company_id=l.company_id))
          OR (l.cost_center_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM cost_centres c WHERE c.id=l.cost_center_id AND c.company_id=l.company_id))
          OR (l.cc1_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM cost_centres c WHERE c.id=l.cc1_id AND c.company_id=l.company_id))
          OR (l.cc2_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM cost_centres c WHERE c.id=l.cc2_id AND c.company_id=l.company_id))
          OR (l.bu_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM business_units b WHERE b.id=l.bu_id AND b.company_id=l.company_id)))` as Row[];
    const foreignDimensionDroppedLines = Number(dropped?.n ?? 0);
    if (foreignDimensionDroppedLines > 0) {
      log.warn('Reversal dropped a dimension that does not belong to this company',
        { companyId, journalEntryId: id, lines: foreignDimensionDroppedLines }, 'accounting');
    }
    await ctx.sql`INSERT INTO gl_journal_lines(journal_entry_id,company_id,gl_account_id,debit,credit,description,project_id,cost_center_id,cc1_id,cc2_id,bu_id,vat_type)
      SELECT ${contraId}::uuid,l.company_id,l.gl_account_id,l.credit,l.debit,'Reversal: ' || COALESCE(l.description,''),p.id,cc.id,c1.id,c2.id,bu.id,l.vat_type
      FROM gl_journal_lines l
      LEFT JOIN projects p ON p.id=l.project_id AND p.company_id=l.company_id
      LEFT JOIN cost_centres cc ON cc.id=l.cost_center_id AND cc.company_id=l.company_id
      LEFT JOIN cost_centres c1 ON c1.id=l.cc1_id AND c1.company_id=l.company_id
      LEFT JOIN cost_centres c2 ON c2.id=l.cc2_id AND c2.company_id=l.company_id
      LEFT JOIN business_units bu ON bu.id=l.bu_id AND bu.company_id=l.company_id
      WHERE l.company_id=${companyId}::uuid AND l.journal_entry_id=${id}::uuid`;
    await registerGeneratedJournal(ctx, parentControl, contraId, 'journal.post');
    const reversal = await postJournalEntry(companyId, contraId, userId, { parentControl });
    const updated = await ctx.sql`UPDATE gl_journal_entries SET reversed_by=${ctx.principal.personId}::uuid,reversed_at=clock_timestamp()
      WHERE company_id=${companyId}::uuid AND id=${id}::uuid AND status='posted' AND reversed_at IS NULL RETURNING id`;
    if (updated.length !== 1) throw new Error('Journal reversal state changed');
    // A reversed capture journal releases its document's posting claim, so "Reverse the journal
    // first" works; the helper still refuses while another live journal or invoice references it.
    const claimReleased = header.source_document_id
      ? await releaseCapturedDocumentPostingClaim(companyId, String(header.source_document_id)) : false;
    log.info('Reversed journal entry', { originalId: id, reversalId: contraId, claimReleased }, 'accounting');
    return { ...reversal, foreignDimensionDroppedLines };
  });
}
