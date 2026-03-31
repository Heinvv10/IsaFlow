/**
 * PRD-060: FibreFlow Accounting Module
 * Journal Entry Service
 */

import { sql, withTransaction } from '@/lib/neon';
import { log } from '@/lib/logger';
import { validateJournalEntry } from '../utils/doubleEntry';
import type {
  JournalEntry,
  JournalLine,
  JournalEntryCreateInput,
  JournalLineInput,
  GLEntryStatus,
  GLEntrySource,
  TrialBalanceRow,
  VatType,
} from '../types/gl.types';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Resolve a userId to a valid UUID — handles non-UUID IDs like 'admin-001' */
async function resolveUserUuid(userId: string): Promise<string> {
  if (UUID_PATTERN.test(userId)) return userId;
  const rows = (await sql`SELECT id FROM users WHERE id::TEXT ~ '^[0-9a-f]{8}-' LIMIT 1`) as { id: string }[];
  return rows.length > 0 ? String(rows[0]!.id) : '00000000-0000-0000-0000-000000000000';
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

interface JournalEntryFilters {
  status?: GLEntryStatus;
  source?: GLEntrySource;
  fiscalPeriodId?: string;
  limit?: number;
  offset?: number;
}

export async function getJournalEntries(companyId: string, filters?: JournalEntryFilters): Promise<{
  entries: JournalEntry[];
  total: number;
}> {
  try {
    const limit = filters?.limit || 50;
    const offset = filters?.offset || 0;

    let rows: Row[];
    let countRows: Row[];

    // Exclude auto-generated entries (auto_grn, auto_supplier_payment, etc.)
    // so only manual journals appear in the UI. Auto entries still feed into
    // trial balance and financial reports via getTrialBalance().
    if (filters?.status && filters?.fiscalPeriodId) {
      rows = (await sql`
        SELECT je.*, fp.period_name AS fiscal_period_name
        FROM gl_journal_entries je
        LEFT JOIN fiscal_periods fp ON fp.id = je.fiscal_period_id
        WHERE je.status = ${filters.status}
          AND je.fiscal_period_id = ${filters.fiscalPeriodId}
          AND je.source NOT LIKE 'auto_%'
        ORDER BY je.entry_date DESC, je.created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `) as Row[];
      countRows = (await sql`
        SELECT COUNT(*) AS cnt FROM gl_journal_entries
        WHERE status = ${filters.status} AND fiscal_period_id = ${filters.fiscalPeriodId}
          AND source NOT LIKE 'auto_%'
      `) as Row[];
    } else if (filters?.status) {
      rows = (await sql`
        SELECT je.*, fp.period_name AS fiscal_period_name
        FROM gl_journal_entries je
        LEFT JOIN fiscal_periods fp ON fp.id = je.fiscal_period_id
        WHERE je.status = ${filters.status}
          AND je.source NOT LIKE 'auto_%'
        ORDER BY je.entry_date DESC, je.created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `) as Row[];
      countRows = (await sql`
        SELECT COUNT(*) AS cnt FROM gl_journal_entries
        WHERE status = ${filters.status} AND source NOT LIKE 'auto_%'
      `) as Row[];
    } else if (filters?.fiscalPeriodId) {
      rows = (await sql`
        SELECT je.*, fp.period_name AS fiscal_period_name
        FROM gl_journal_entries je
        LEFT JOIN fiscal_periods fp ON fp.id = je.fiscal_period_id
        WHERE je.fiscal_period_id = ${filters.fiscalPeriodId}
          AND je.source NOT LIKE 'auto_%'
        ORDER BY je.entry_date DESC, je.created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `) as Row[];
      countRows = (await sql`
        SELECT COUNT(*) AS cnt FROM gl_journal_entries
        WHERE fiscal_period_id = ${filters.fiscalPeriodId} AND source NOT LIKE 'auto_%'
      `) as Row[];
    } else {
      rows = (await sql`
        SELECT je.*, fp.period_name AS fiscal_period_name
        FROM gl_journal_entries je
        LEFT JOIN fiscal_periods fp ON fp.id = je.fiscal_period_id
        WHERE je.source NOT LIKE 'auto_%'
        ORDER BY je.entry_date DESC, je.created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `) as Row[];
      countRows = (await sql`
        SELECT COUNT(*) AS cnt FROM gl_journal_entries WHERE source NOT LIKE 'auto_%'
      `) as Row[];
    }

    return {
      entries: rows.map(mapEntryRow),
      total: Number(countRows[0].cnt),
    };
  } catch (err) {
    log.error('Failed to get journal entries', { error: err }, 'accounting');
    throw err;
  }
}

export async function getJournalEntryById(companyId: string, 
  id: string
): Promise<(JournalEntry & { lines: JournalLine[] }) | null> {
  try {
    const entryRows = (await sql`
      SELECT je.*, fp.period_name AS fiscal_period_name
      FROM gl_journal_entries je
      LEFT JOIN fiscal_periods fp ON fp.id = je.fiscal_period_id
      WHERE je.id = ${id}
    `) as Row[];
    if (entryRows.length === 0) return null;

    const lineRows = (await sql`
      SELECT jl.*, a.account_code, a.account_name
      FROM gl_journal_lines jl
      JOIN gl_accounts a ON a.id = jl.gl_account_id
      WHERE jl.journal_entry_id = ${id}
      ORDER BY jl.created_at
    `) as Row[];

    return {
      ...mapEntryRow(entryRows[0]),
      lines: lineRows.map(mapLineRow),
    };
  } catch (err) {
    log.error('Failed to get journal entry', { id, error: err }, 'accounting');
    throw err;
  }
}

export async function createJournalEntry(companyId: string, 
  input: JournalEntryCreateInput,
  userId: string
): Promise<JournalEntry> {
  try {
    const validation = validateJournalEntry(input.lines);
    if (!validation.valid) {
      throw new Error(`Invalid journal entry: ${validation.errors.join('; ')}`);
    }

    let fiscalPeriodId = input.fiscalPeriodId;
    if (!fiscalPeriodId) {
      const periodRows = (await sql`
        SELECT id FROM fiscal_periods
        WHERE start_date <= ${input.entryDate}::DATE AND end_date >= ${input.entryDate}::DATE
        LIMIT 1
      `) as Row[];
      if (periodRows.length > 0) {
        fiscalPeriodId = String(periodRows[0].id);
      }
    }

    const safeUserId = await resolveUserUuid(userId);

    // Use HTTP-based sql (not Pool/WebSocket withTransaction) for reliability
    const rows = (await sql`
      INSERT INTO gl_journal_entries (
        company_id, entry_date, fiscal_period_id, description, source,
        source_document_id, created_by
      ) VALUES (
        ${companyId}::UUID, ${input.entryDate}, ${fiscalPeriodId || null},
        ${input.description || null}, ${input.source || 'manual'},
        ${input.sourceDocumentId || null}, ${safeUserId}::UUID
      )
      RETURNING *
    `) as Row[];

    const entryRow = rows[0] as Row;
    const entryId = String(entryRow.id);

    for (const line of input.lines) {
      await sql`
        INSERT INTO gl_journal_lines (
          journal_entry_id, gl_account_id, debit, credit,
          description, project_id, cost_center_id, bu_id, vat_type
        ) VALUES (
          ${entryId}::UUID, ${line.glAccountId}::UUID,
          ${line.debit}, ${line.credit},
          ${line.description || null},
          ${line.projectId || null},
          ${line.costCenterId || null},
          ${line.buId || null},
          ${line.vatType || null}
        )
      `;
    }

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

export async function postJournalEntry(companyId: string, id: string, userId: string): Promise<JournalEntry> {
  try {
    const entry = await getJournalEntryById(companyId, id);
    if (!entry) throw new Error(`Journal entry ${id} not found`);
    if (entry.status !== 'draft') throw new Error(`Cannot post entry with status: ${entry.status}`);

    if (entry.fiscalPeriodId) {
      const period = (await sql`
        SELECT status FROM fiscal_periods WHERE id = ${entry.fiscalPeriodId}
      `) as Row[];
      if (period.length > 0 && String(period[0].status) !== 'open') {
        throw new Error(`Cannot post to ${period[0].status} fiscal period`);
      }
    }

    if (entry.lines) {
      const validation = validateJournalEntry(entry.lines.map(l => ({
        glAccountId: l.glAccountId,
        debit: l.debit,
        credit: l.credit,
      })));
      if (!validation.valid) {
        throw new Error(`Entry not balanced: ${validation.errors.join('; ')}`);
      }
    }

    const safePostUserId = await resolveUserUuid(userId);
    const rows = (await sql`
      UPDATE gl_journal_entries
      SET status = 'posted', posted_by = ${safePostUserId}::UUID, posted_at = NOW()
      WHERE id = ${id}
      RETURNING *
    `) as Row[];

    log.info('Posted journal entry', { id, entryNumber: String(rows[0].entry_number) }, 'accounting');
    return mapEntryRow(rows[0]);
  } catch (err) {
    log.error('Failed to post journal entry', { id, error: err }, 'accounting');
    throw err;
  }
}

export async function reverseJournalEntry(companyId: string, id: string, userId: string): Promise<JournalEntry> {
  try {
    const entry = await getJournalEntryById(companyId, id);
    if (!entry) throw new Error(`Journal entry ${id} not found`);
    if (entry.status !== 'posted') throw new Error('Can only reverse posted entries');
    if (!entry.lines || entry.lines.length === 0) throw new Error('Entry has no lines');

    const reversalLines: JournalLineInput[] = entry.lines.map(l => ({
      glAccountId: l.glAccountId,
      debit: l.credit,
      credit: l.debit,
      description: `Reversal: ${l.description || ''}`,
      projectId: l.projectId,
      costCenterId: l.costCenterId,
    }));

    const reversalEntry = await createJournalEntry(companyId, {
      entryDate: new Date().toISOString().split('T')[0]!,
      description: `Reversal of ${entry.entryNumber}`,
      source: entry.source,
      fiscalPeriodId: entry.fiscalPeriodId,
      lines: reversalLines,
    }, userId);

    await postJournalEntry('', reversalEntry.id, userId);

    await sql`
      UPDATE gl_journal_entries
      SET status = 'reversed', reversed_by = ${userId}::UUID, reversed_at = NOW()
      WHERE id = ${id}
    `;

    await sql`
      UPDATE gl_journal_entries
      SET reversal_of_id = ${id}::UUID
      WHERE id = ${reversalEntry.id}
    `;

    log.info('Reversed journal entry', {
      originalId: id,
      reversalId: reversalEntry.id,
    }, 'accounting');

    return reversalEntry;
  } catch (err) {
    log.error('Failed to reverse journal entry', { id, error: err }, 'accounting');
    throw err;
  }
}

export async function getTrialBalance(companyId: string, fiscalPeriodId: string, costCentreId?: string): Promise<TrialBalanceRow[]> {
  try {
    if (!costCentreId) {
      // Use direct query with company_id filter instead of the SQL function
      const rows = (await sql`
        SELECT a.account_code, a.account_name, a.account_type, a.normal_balance,
          COALESCE(b.debit_total, 0) AS debit_balance,
          COALESCE(b.credit_total, 0) AS credit_balance
        FROM gl_accounts a
        LEFT JOIN gl_account_balances b ON b.gl_account_id = a.id AND b.fiscal_period_id = ${fiscalPeriodId}::UUID
        WHERE a.is_active = true
          AND a.company_id = ${companyId}::UUID
          AND (COALESCE(b.debit_total, 0) != 0 OR COALESCE(b.credit_total, 0) != 0)
        ORDER BY a.account_code
      `) as Row[];
      return rows.map(r => ({
        accountCode: String(r.account_code),
        accountName: String(r.account_name),
        accountType: String(r.account_type),
        normalBalance: String(r.normal_balance) as 'debit' | 'credit',
        debitBalance: Number(r.debit_balance),
        creditBalance: Number(r.credit_balance),
      }));
    }

    // Direct query with cost centre filter
    const rows = (await sql`
      SELECT ga.account_code, ga.account_name, ga.account_type, ga.normal_balance,
        COALESCE(SUM(jl.debit), 0) AS total_debit,
        COALESCE(SUM(jl.credit), 0) AS total_credit
      FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      JOIN gl_accounts ga ON ga.id = jl.gl_account_id
      WHERE je.status = 'posted'
        AND je.company_id = ${companyId}::UUID
        AND je.fiscal_period_id = ${fiscalPeriodId}::UUID
        AND jl.cost_center_id = ${costCentreId}::UUID
      GROUP BY ga.id, ga.account_code, ga.account_name, ga.account_type, ga.normal_balance
      HAVING COALESCE(SUM(jl.debit), 0) != 0 OR COALESCE(SUM(jl.credit), 0) != 0
      ORDER BY ga.account_code
    `) as Row[];

    return rows.map(r => {
      const net = Number(r.total_debit) - Number(r.total_credit);
      return {
        accountCode: String(r.account_code),
        accountName: String(r.account_name),
        accountType: String(r.account_type),
        normalBalance: String(r.normal_balance) as 'debit' | 'credit',
        debitBalance: net > 0 ? net : 0,
        creditBalance: net < 0 ? Math.abs(net) : 0,
      };
    });
  } catch (err) {
    log.error('Failed to get trial balance', { fiscalPeriodId, error: err }, 'accounting');
    throw err;
  }
}

function mapEntryRow(row: Row): JournalEntry {
  return {
    id: String(row.id),
    entryNumber: row.entry_number ? String(row.entry_number) : '',
    entryDate: String(row.entry_date),
    fiscalPeriodId: row.fiscal_period_id ? String(row.fiscal_period_id) : undefined,
    description: row.description ? String(row.description) : undefined,
    source: String(row.source) as GLEntrySource,
    sourceDocumentId: row.source_document_id ? String(row.source_document_id) : undefined,
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

function mapLineRow(row: Row): JournalLine {
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
