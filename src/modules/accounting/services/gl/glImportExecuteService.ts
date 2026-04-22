/**
 * GL Import Execute Service
 * Import orchestration (write path) — split from glImportService.ts.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { ImportRow, ImportResult } from './glImportService';
import type { VatType } from '../../types/gl.types';
type Row = DbRow;

export async function importJournalEntries(
  companyId: string,
  rows: ImportRow[],
  userId: string,
  postImmediately: boolean,
): Promise<ImportResult> {
  try {
    const accountRows = (await sql`
      SELECT account_code, id
      FROM gl_accounts
      WHERE company_id = ${companyId}::UUID
        AND is_active = true
    `) as Row[];
    const accountMap = new Map<string, string>(
      accountRows.map((r: Row) => [String(r.account_code), String(r.id)]),
    );

    const ccRows = (await sql`
      SELECT code, id
      FROM cost_centres
      WHERE company_id = ${companyId}::UUID
        AND is_active = true
    `) as Row[];
    const ccMap = new Map<string, string>(
      ccRows.map((r: Row) => [String(r.code).toLowerCase(), String(r.id)]),
    );

    // Group rows into journal entries: same date + same reference = one entry
    const grouped = new Map<string, ImportRow[]>();
    for (const row of rows) {
      const key = `${row.date}||${row.reference || ''}`;
      const group = grouped.get(key) ?? [];
      group.push(row);
      grouped.set(key, group);
    }

    let entriesCreated = 0;
    let linesCreated = 0;
    let totalValue = 0;
    const status = postImmediately ? 'posted' : 'draft';

    for (const [, groupRows] of grouped) {
      const firstRow = groupRows[0]!;

      const periodRows = (await sql`
        SELECT id FROM fiscal_periods
        WHERE company_id = ${companyId}::UUID
          AND start_date <= ${firstRow.date}::DATE
          AND end_date >= ${firstRow.date}::DATE
        LIMIT 1
      `) as Row[];
      const fiscalPeriodId = periodRows.length > 0 ? String(periodRows[0]!.id) : null;

      const description = firstRow.reference
        ? `${firstRow.reference}: ${firstRow.description}`
        : firstRow.description;

      const postedBy = postImmediately ? userId : null;

      const entryInsert = (await sql`
        INSERT INTO gl_journal_entries (
          company_id, entry_date, fiscal_period_id, description,
          source, created_by, status,
          posted_by, posted_at,
          posting_agent
        ) VALUES (
          ${companyId}::UUID,
          ${firstRow.date}::DATE,
          ${fiscalPeriodId}::UUID,
          ${description},
          'import',
          ${userId}::UUID,
          ${status},
          ${postedBy}::UUID,
          ${postImmediately ? sql`NOW()` : sql`NULL`},
          'import:gl-manual'
        )
        RETURNING id
      `) as Row[];

      const entryId = String(entryInsert[0]!.id);
      entriesCreated++;

      for (const row of groupRows) {
        const accountId = accountMap.get(String(row.accountCode).trim());
        if (!accountId) continue; // already validated upstream

        const ccId = row.costCentre
          ? (ccMap.get(row.costCentre.trim().toLowerCase()) ?? null)
          : null;

        const vatType = (row.vatCode?.trim() as VatType) || null;

        await sql`
          INSERT INTO gl_journal_lines (
            journal_entry_id, gl_account_id, debit, credit,
            description, vat_type, cost_center_id, company_id
          ) VALUES (
            ${entryId}::UUID,
            ${accountId}::UUID,
            ${Number(row.debit) || 0},
            ${Number(row.credit) || 0},
            ${row.description},
            ${vatType},
            ${ccId}::UUID,
            ${companyId}::UUID
          )
        `;

        linesCreated++;
        totalValue += Number(row.debit) || 0;
      }
    }

    log.info('Imported journal entries', {
      companyId, entriesCreated, linesCreated, totalValue, postImmediately,
    }, 'gl-import');

    return { entriesCreated, linesCreated, totalValue };
  } catch (err) {
    log.error('Failed to import journal entries', { error: err }, 'gl-import');
    throw err;
  }
}
