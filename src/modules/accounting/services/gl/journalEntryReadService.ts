/**
 * The read half of journal entries: list, fetch by id, and the row mappers. Split out of
 * journalEntryCrudService (which re-exports all of it) to keep that file under the 300-line cap.
 */
import { sql, type DbRow } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { log } from '@/lib/logger';
import type { JournalEntry, JournalLine, GLEntryStatus, GLEntrySource, VatType } from '../../types/gl.types';

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
    cc1Id: row.cc1_id ? String(row.cc1_id) : undefined,
    cc2Id: row.cc2_id ? String(row.cc2_id) : undefined,
    buId: row.bu_id ? String(row.bu_id) : undefined,
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
