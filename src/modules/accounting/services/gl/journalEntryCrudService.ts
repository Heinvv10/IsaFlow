/**
 * Journal Entry CRUD Service
 * Create, read operations for GL journal entries.
 * Trial balance split to trialBalanceService.ts.
 */

import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { randomUUID } from 'crypto';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { validateJournalEntry } from '../../utils/doubleEntry';
import type { JournalEntry, JournalLine, JournalEntryCreateInput, GLEntryStatus, GLEntrySource, VatType } from '../../types/gl.types';
import { defaultHumanMeta } from './journalEntryMeta';
import { ensureFiscalPeriodForDate } from './fiscalPeriodAutoCreate';
import type { JournalEntryMeta } from './journalEntryMeta';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function resolveUserUuid(userId: string): Promise<string> {
  if (UUID_PATTERN.test(userId)) return userId;
  const rows = (await sql`SELECT id FROM users WHERE id::TEXT ~ '^[0-9a-f]{8}-' LIMIT 1`) as { id: string }[];
  return rows.length > 0 ? String(rows[0]!.id) : '00000000-0000-0000-0000-000000000000';
}

type Row = DbRow;

export interface JournalEntryFilters {
  status?: GLEntryStatus;
  source?: GLEntrySource;
  fiscalPeriodId?: string;
  limit?: number;
  offset?: number;
}

export function mapEntryRow(row: Row): JournalEntry {
  return {
    id: String(row.id),
    entryNumber: row.entry_number ? String(row.entry_number) : '',
    entryDate: fmtDate(row.entry_date),
    fiscalPeriodId: row.fiscal_period_id ? String(row.fiscal_period_id) : undefined,
    description: row.description ? String(row.description) : undefined,
    source: String(row.source) as GLEntrySource,
    sourceDocumentId: row.source_document_id ? String(row.source_document_id) : undefined,
    sourceRecordId: row.source_record_id ? String(row.source_record_id) : undefined,
    status: String(row.status) as GLEntryStatus,
    postedBy: row.posted_by ? String(row.posted_by) : undefined,
    postedAt: row.posted_at ? String(row.posted_at) : undefined,
    reversedBy: row.reversed_by ? String(row.reversed_by) : undefined,
    reversedAt: row.reversed_at ? String(row.reversed_at) : undefined,
    reversalOfId: row.reversal_of_id ? String(row.reversal_of_id) : undefined,
    createdBy: String(row.created_by),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function mapLineRow(row: Row): JournalLine {
  return {
    id: String(row.id),
    journalEntryId: String(row.journal_entry_id),
    glAccountId: String(row.gl_account_id),
    debit: Number(row.debit),
    credit: Number(row.credit),
    description: row.description ? String(row.description) : undefined,
    projectId: row.project_id ? String(row.project_id) : undefined,
    costCenterId: row.cost_center_id ? String(row.cost_center_id) : undefined,
    vatType: row.vat_type ? String(row.vat_type) as VatType : undefined,
    createdAt: String(row.created_at),
    accountCode: row.account_code ? String(row.account_code) : undefined,
    accountName: row.account_name ? String(row.account_name) : undefined,
  };
}

export async function getJournalEntries(companyId: string, filters?: JournalEntryFilters): Promise<{
  entries: JournalEntry[];
  total: number;
}> {
  try {
    const limit = Math.min(filters?.limit || 50, 200);
    const offset = filters?.offset || 0;

    let rows: Row[];
    let countRows: Row[];

    // A 'reversed' status filter maps to reversed_at IS NOT NULL: after the
    // reversal-semantics fix the original entry keeps status='posted' and
    // "reversed" lives in reversed_at, so filtering on status='reversed' would
    // otherwise match nothing. Any other status is an exact status match.
    if (filters?.status && filters?.fiscalPeriodId) {
      rows = (await sql`
        SELECT je.*, fp.period_name AS fiscal_period_name
        FROM gl_journal_entries je
        LEFT JOIN fiscal_periods fp ON fp.id = je.fiscal_period_id
        WHERE je.company_id = ${companyId}
          AND (
            (${filters.status} = 'reversed' AND je.reversed_at IS NOT NULL)
            OR (${filters.status} <> 'reversed' AND je.status = ${filters.status})
          )
          AND je.fiscal_period_id = ${filters.fiscalPeriodId}
          AND je.source NOT LIKE 'auto_%'
        ORDER BY je.entry_date DESC, je.created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `) as Row[];
      countRows = (await sql`
        SELECT COUNT(*) AS cnt FROM gl_journal_entries
        WHERE company_id = ${companyId}
          AND (
            (${filters.status} = 'reversed' AND reversed_at IS NOT NULL)
            OR (${filters.status} <> 'reversed' AND status = ${filters.status})
          )
          AND fiscal_period_id = ${filters.fiscalPeriodId}
          AND source NOT LIKE 'auto_%'
      `) as Row[];
    } else if (filters?.status) {
      rows = (await sql`
        SELECT je.*, fp.period_name AS fiscal_period_name
        FROM gl_journal_entries je
        LEFT JOIN fiscal_periods fp ON fp.id = je.fiscal_period_id
        WHERE je.company_id = ${companyId}
          AND (
            (${filters.status} = 'reversed' AND je.reversed_at IS NOT NULL)
            OR (${filters.status} <> 'reversed' AND je.status = ${filters.status})
          )
          AND je.source NOT LIKE 'auto_%'
        ORDER BY je.entry_date DESC, je.created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `) as Row[];
      countRows = (await sql`
        SELECT COUNT(*) AS cnt FROM gl_journal_entries
        WHERE company_id = ${companyId}
          AND (
            (${filters.status} = 'reversed' AND reversed_at IS NOT NULL)
            OR (${filters.status} <> 'reversed' AND status = ${filters.status})
          )
          AND source NOT LIKE 'auto_%'
      `) as Row[];
    } else if (filters?.fiscalPeriodId) {
      rows = (await sql`
        SELECT je.*, fp.period_name AS fiscal_period_name
        FROM gl_journal_entries je
        LEFT JOIN fiscal_periods fp ON fp.id = je.fiscal_period_id
        WHERE je.company_id = ${companyId}
          AND je.fiscal_period_id = ${filters.fiscalPeriodId}
          AND je.source NOT LIKE 'auto_%'
        ORDER BY je.entry_date DESC, je.created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `) as Row[];
      countRows = (await sql`
        SELECT COUNT(*) AS cnt FROM gl_journal_entries
        WHERE company_id = ${companyId} AND fiscal_period_id = ${filters.fiscalPeriodId} AND source NOT LIKE 'auto_%'
      `) as Row[];
    } else {
      rows = (await sql`
        SELECT je.*, fp.period_name AS fiscal_period_name
        FROM gl_journal_entries je
        LEFT JOIN fiscal_periods fp ON fp.id = je.fiscal_period_id
        WHERE je.company_id = ${companyId}
          AND je.source NOT LIKE 'auto_%'
        ORDER BY je.entry_date DESC, je.created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `) as Row[];
      countRows = (await sql`
        SELECT COUNT(*) AS cnt FROM gl_journal_entries WHERE company_id = ${companyId} AND source NOT LIKE 'auto_%'
      `) as Row[];
    }

    return { entries: rows.map(mapEntryRow), total: Number(countRows[0]!.cnt) };
  } catch (err) {
    log.error('Failed to get journal entries', { error: err }, 'accounting');
    throw err;
  }
}

export async function getJournalEntryById(companyId: string,
  id: string,
): Promise<(JournalEntry & { lines: JournalLine[] }) | null> {
  try {
    const entryRows = (await sql`
      SELECT je.*, fp.period_name AS fiscal_period_name
      FROM gl_journal_entries je
      LEFT JOIN fiscal_periods fp ON fp.id = je.fiscal_period_id
      WHERE je.id = ${id} AND je.company_id = ${companyId}
    `) as Row[];
    if (entryRows.length === 0) return null;

    const lineRows = (await sql`
      SELECT jl.*, a.account_code, a.account_name
      FROM gl_journal_lines jl
      JOIN gl_accounts a ON a.id = jl.gl_account_id AND a.company_id = jl.company_id
      WHERE jl.journal_entry_id = ${id} AND jl.company_id = ${companyId}::UUID
      ORDER BY jl.created_at
    `) as Row[];

    return { ...mapEntryRow(entryRows[0]!), lines: lineRows.map(mapLineRow) };
  } catch (err) {
    log.error('Failed to get journal entry', { id, error: err }, 'accounting');
    throw err;
  }
}

export async function createJournalEntry(
  companyId: string,
  input: JournalEntryCreateInput,
  userId: string,
  meta?: JournalEntryMeta,
): Promise<JournalEntry> {
  try {
    const validation = validateJournalEntry(input.lines);
    if (!validation.valid) throw new Error(`Invalid journal entry: ${validation.errors.join('; ')}`);

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

    // Generate the entry UUID client-side so we can reference it in line inserts
    // without needing a sequential transaction (the direct Neon endpoint may be unreachable).
    const entryId = randomUUID();

    // Use neon serverless transaction() — batches all inserts into one HTTP round-trip
    // via the pooler, which is always reachable.
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
          description, project_id, cost_center_id, bu_id, vat_type, company_id
        ) VALUES (
          ${entryId}::UUID, ${line.glAccountId}::UUID,
          ${line.debit}, ${line.credit},
          ${line.description || null},
          ${line.projectId || null},
          ${line.costCenterId || null},
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

// Trial balance split to trialBalanceService.ts — re-exported for backward compat
export { getTrialBalance } from './trialBalanceService';
