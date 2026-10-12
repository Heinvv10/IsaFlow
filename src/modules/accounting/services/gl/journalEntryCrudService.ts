/** Journal CRUD; trial balance lives in trialBalanceService.ts. */

import { sql, type DbRow } from '@/lib/neon';
import { randomUUID } from 'crypto';
import { log } from '@/lib/logger';
import { withAlsTransaction } from '@/lib/alsTransaction';
import { validateJournalEntry } from '../../utils/doubleEntry';
import type { JournalEntry, JournalEntryCreateInput } from '../../types/gl.types';
import { mapEntryRow } from './journalEntryReadService';
import { assertJournalLinesOwned } from './journalLineOwnership';
import type { DimensionAssignmentMode } from './journalCostCentreValidation';
import { applyJournalDimensionPolicy } from './dimensions/dimensionPolicy';
import { assertCostCentresPlaced } from './dimensions/costCentrePick';
import { defaultHumanMeta, type JournalEntryMeta } from './journalEntryMeta';
import { ensureFiscalPeriodForDate } from './fiscalPeriodAutoCreate';
import { assertJournalVatPeriodOpen } from './journalVatLockGuard';
import { planLockedVatPosting } from './vatLateClaimPlan';
import { assertNoLateClaimClearingLines } from './lateClaimClearingGuard';
import { assertDocumentNotAlreadyPosted } from './documentJournalClaimGuard';
import { assertNoHeaderAccountLines } from './headerAccountGuard';
import { ledgerEntryDay } from './journalDateGuard'; // S4: the date window, first, on the day Postgres stores

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function resolveUserUuid(userId: string): Promise<string> {
  if (UUID_PATTERN.test(userId)) return userId;
  const rows = (await sql`SELECT id FROM users WHERE id::TEXT ~ '^[0-9a-f]{8}-' LIMIT 1`) as { id: string }[];
  return rows.length > 0 ? String(rows[0]!.id) : '00000000-0000-0000-0000-000000000000';
}

type Row = DbRow;

export { mapEntryRow, mapLineRow, getJournalEntries, getJournalEntryById } from './journalEntryReadService';
export type { JournalEntryFilters } from './journalEntryReadService';

async function createJournalEntryInTransaction(
  companyId: string,
  input: JournalEntryCreateInput,
  userId: string,
  meta?: JournalEntryMeta,
  opts?: { dimensionAssignmentMode?: DimensionAssignmentMode; allowLateInputClaim?: boolean; reversal?: boolean;
    /** Accounts this journal's contra legs sit on — exempt from the header rule (headerAccountGuard.ts). */
    contraAccountIds?: readonly string[] },
): Promise<JournalEntry> {
  try {
    const validation = validateJournalEntry(input.lines);
    if (!validation.valid) throw new Error(`Invalid journal entry: ${validation.errors.join('; ')}`);
    assertCostCentresPlaced(input.lines); // a pick goes through placeCostCentres; the legacy column is never written
    await assertNoHeaderAccountLines(companyId, input.lines, { contraAccountIds: opts?.contraAccountIds }); // D1
    // Settlements carry no dimensions; CC1 is derived from CC2 (dimensions/dimensionPolicy.ts). New lines only.
    if ((opts?.dimensionAssignmentMode ?? 'new-assignment') === 'new-assignment') {
      input = { ...input, lines: await applyJournalDimensionPolicy(companyId, input.source, input.lines) };
    }
    await assertJournalLinesOwned(
      companyId,
      input.lines,
      opts?.dimensionAssignmentMode,
    ); // journalLineOwnership.ts
    await assertNoLateClaimClearingLines(companyId, input.lines, input.source, opts?.reversal === true);
    // One document, one claim: a reversal never sets sourceDocumentId (see
    // journalEntryPostingService#reverseJournalEntryInner), so this never
    // blocks a reversal — only a second live claim on the same document.
    if (input.sourceDocumentId) {
      await assertDocumentNotAlreadyPosted(companyId, input.sourceDocumentId);
    }
    // A journal that moves a VAT figure into a locked (filed) VAT period can
    // never post, so refuse it BEFORE the draft exists: a draft refused only at
    // post was committed by every route that answers the refusal with a 4xx.
    // Opted in (human-initiated, vatLateClaimPlan.ts): a draft the s16(3) split can post is let through.
    if (opts?.allowLateInputClaim) await planLockedVatPosting(companyId, input.entryDate, input.lines);
    else await assertJournalVatPeriodOpen(companyId, input.entryDate, input.lines);

    let fiscalPeriodId = input.fiscalPeriodId;
    if (!fiscalPeriodId) {
      // Resolves the covering period, CREATING that fiscal year when it does
      // not exist and the year is plausible. A miss used to INSERT
      // fiscal_period_id NULL, which postJournalEntry's `if (entry.fiscalPeriodId)`
      // guard skips — so the entry posted outside every period-bounded report.
      // Still nullable by design, for a date outside the auto-create window.
      // Why create rather than refuse, and the bound: fiscalPeriodAutoCreate.ts.
      fiscalPeriodId = (await ensureFiscalPeriodForDate(companyId, input.entryDate)) ?? undefined;
    } else {
      // P2.2: a caller-supplied period must actually COVER the entry date —
      // the API passes client-supplied fiscalPeriodId through, and a
      // mismatched value misfiles the entry in period reports forever.
      const ok = (await sql`
        SELECT 1 FROM fiscal_periods
        WHERE id = ${fiscalPeriodId} AND company_id = ${companyId}::UUID
          AND start_date <= ${input.entryDate}::DATE AND end_date >= ${input.entryDate}::DATE
      `) as Row[];
      if (ok.length === 0) {
        throw new Error(
          `fiscalPeriodId does not cover entryDate ${input.entryDate} (or belongs to another company)`,
        );
      }
    }

    const safeUserId = await resolveUserUuid(userId);
    const resolvedMeta = meta ?? defaultHumanMeta(userId);

    // Generate the UUID before batching the header and line inserts.
    const entryId = randomUUID();

    const [entryResult] = await sql.transaction([
      sql`
        INSERT INTO gl_journal_entries (
          id, company_id, entry_date, fiscal_period_id, description, source,
          source_document_id, source_record_id, reference, created_by,
          posting_agent, source_document_hash, extraction_confidence,
          actor_type, actor_token_jti
        ) VALUES (
          ${entryId}::UUID, ${companyId}::UUID, ${input.entryDate}, ${fiscalPeriodId || null},
          ${input.description || null}, ${input.source || 'manual'},
          ${input.sourceDocumentId || null}, ${input.sourceRecordId || null}::UUID,
          ${input.reference || null}, ${safeUserId}::UUID,
          ${resolvedMeta.postingAgent},
          ${resolvedMeta.sourceDocumentHash ?? null},
          ${resolvedMeta.extractionConfidence ?? null},
          ${resolvedMeta.actorType ?? null},
          ${resolvedMeta.actorTokenJti ?? null}
        )
        RETURNING *
      `,
      ...input.lines.map((line) => sql`
        INSERT INTO gl_journal_lines (
          journal_entry_id, gl_account_id, debit, credit,
          description, project_id, cc1_id, cc2_id, bu_id, vat_type, company_id
        ) VALUES (
          ${entryId}::UUID, ${line.glAccountId}::UUID,
          ${line.debit ?? 0}, ${line.credit ?? 0},
          ${line.description || null},
          ${line.projectId || null},
          ${line.cc1Id || null}::UUID,
          ${line.cc2Id || null}::UUID,
          ${line.buId || null}::UUID,
          ${line.vatType || null},
          ${companyId}::UUID
        )
      `),
    ]);

    const entryRow = (entryResult as Row[])[0] as Row;

    log.info('Created journal entry', {
      entryId: String(entryRow.id),
      entryNumber: String(entryRow.entry_number),
      lineCount: input.lines.length,
    }, 'accounting');

    return mapEntryRow(entryRow);
  } catch (err) {
    log.error('Failed to create journal entry', { error: err }, 'accounting');
    throw err;
  }
}

/**
 * Keep dimension validation locks and journal insertion in one transaction.
 * Authenticated requests already provide that transaction; direct service and
 * script callers get an equivalent ALS-bound transaction here.
 */
export async function createJournalEntry(
  companyId: string,
  input: JournalEntryCreateInput,
  userId: string,
  meta?: JournalEntryMeta,
  opts?: { dimensionAssignmentMode?: DimensionAssignmentMode; allowLateInputClaim?: boolean; reversal?: boolean;
    /** Accounts this journal's contra legs sit on — exempt from the header rule (headerAccountGuard.ts). */
    contraAccountIds?: readonly string[] },
): Promise<JournalEntry> {
  return withAlsTransaction({ companyId, userId }, async () => createJournalEntryInTransaction(
    companyId, { ...input, entryDate: await ledgerEntryDay(input.entryDate) }, userId, meta, opts));
}

// Trial balance split to trialBalanceService.ts — re-exported for backward compat
export { getTrialBalance } from './trialBalanceService';
