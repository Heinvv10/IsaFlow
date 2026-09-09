/**
 * GL Import Execute Service
 * Import orchestration (write path) — split from glImportService.ts.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { ImportRow, ImportResult } from './glImportService';
import { createJournalEntry } from './journalEntryService';
import { validateJournalEntry } from '../../utils/doubleEntry';
import type { JournalLineInput, VatType } from '../../types/gl.types';
import {executeLegacyHistoricalGl,type HistoricalGlImportBindings} from '../controls/historicalImportLegacyGl';
type Row = DbRow;

/**
 * Thrown for problems found while resolving and validating the file, BEFORE
 * anything is written: an unmapped account code, or a group that does not
 * balance.
 *
 * The route may only answer 4xx for these. withAuth finalises on
 * `statusCode >= 500`, so a 4xx COMMITs — reporting a failure that happened
 * mid-write as a 400 would leave the already-posted groups behind.
 */
export class ImportValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportValidationError';
  }
}

/** One journal's worth of rows, resolved against the chart of accounts. */
interface ResolvedGroup {
  entryDate: string;
  description: string;
  reference?: string;
  lines: JournalLineInput[];
  totalDebit: number;
}

/**
 * Import rows as journal entries — one entry per date+reference group.
 *
 * Every row is resolved and validated BEFORE the first entry is written. The
 * previous shape resolved lazily inside the write loop and did
 * `if (!accountId) continue;`, which dropped a row with an unrecognised account
 * code and posted the rest of its group anyway — an entry short by exactly that
 * row. Nothing caught it: the header was INSERTed already at status='posted',
 * and trg_gl_je_balanced only fires on UPDATE. Resolving up front means a bad
 * code late in the file cannot leave earlier groups half-imported, and handing
 * each group to createJournalEntry runs validateJournalEntry on it.
 */
export async function importJournalEntries(
  companyId: string,
  rows: ImportRow[],
  userId: string,
  postImmediately: boolean,
  savedImports?: HistoricalGlImportBindings,
): Promise<ImportResult> {
  if (postImmediately) return executeLegacyHistoricalGl(companyId, rows, userId, savedImports);
  if (savedImports) throw new ImportValidationError('Saved historical imports execute through posting; use source preparation for staging');
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

    // ── Resolve every group before writing anything ──────────────────────────
    const resolved: ResolvedGroup[] = [];
    for (const [, groupRows] of grouped) {
      const firstRow = groupRows[0]!;
      const lines: JournalLineInput[] = [];
      let totalDebit = 0;

      for (const row of groupRows) {
        const code = String(row.accountCode).trim();
        const accountId = accountMap.get(code);
        if (!accountId) {
          // Was `continue`. The preview endpoint validates codes, but nothing
          // obliges the execute caller to have run it, so enforce it here.
          throw new ImportValidationError(
            `Import row "${row.description}" (${row.date}) references account code ${code}, which does not exist or is inactive for this company`,
          );
        }

        const ccId = row.costCentre
          ? (ccMap.get(row.costCentre.trim().toLowerCase()) ?? null)
          : null;

        const debit = Number(row.debit) || 0;
        const credit = Number(row.credit) || 0;
        totalDebit += debit;

        lines.push({
          glAccountId: accountId,
          debit,
          credit,
          description: row.description,
          ...((row.vatCode?.trim() as VatType) ? { vatType: row.vatCode!.trim() as VatType } : {}),
          ...(ccId ? { costCenterId: ccId } : {}),
        });
      }

      // Balance-check every group BEFORE any of them is written.
      //
      // createJournalEntry validates too, but it does so per group inside the
      // write loop — group 1 would already be created and posted when group 2
      // threw, and pages/api/accounting/gl-import.ts turns that throw into a
      // 400. withAuth finalises on `statusCode >= 500`, so the 400 COMMITs:
      // the user is told the import failed while a prefix of it stays
      // permanently posted, and re-uploading the file posts that prefix again
      // (there is no idempotency key on this path). Rejecting here means an
      // invalid file is refused with nothing written at all.
      const validation = validateJournalEntry(lines);
      if (!validation.valid) {
        throw new ImportValidationError(
          `Import group ${firstRow.reference ? `"${firstRow.reference}" ` : ''}(${firstRow.date}) is invalid: ${validation.errors.join('; ')}`,
        );
      }

      resolved.push({
        entryDate: firstRow.date,
        description: firstRow.reference
          ? `${firstRow.reference}: ${firstRow.description}`
          : firstRow.description,
        ...(firstRow.reference ? { reference: firstRow.reference } : {}),
        lines,
        totalDebit,
      });
    }

    // ── Write ────────────────────────────────────────────────────────────────
    let entriesCreated = 0;
    let linesCreated = 0;
    let totalValue = 0;

    for (const group of resolved) {
      // createJournalEntry resolves the fiscal period from entryDate and runs
      // validateJournalEntry, so an unbalanced group is rejected here rather
      // than becoming a posted entry nobody checked.
      await createJournalEntry(companyId, {
        entryDate: group.entryDate,
        description: group.description,
        source: 'auto_gl_import',
        ...(group.reference ? { reference: group.reference } : {}),
        lines: group.lines,
      }, userId, { postingAgent: 'import:gl-manual' });

      entriesCreated++;
      linesCreated += group.lines.length;
      totalValue += group.totalDebit;
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
