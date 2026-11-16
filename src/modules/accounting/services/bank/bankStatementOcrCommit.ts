/**
 * Commit of an AI-read statement import (bank_statement_imports → one bank_import_batches row + its lines).
 * Split out of bankStatementOcrService.ts (which re-exports it) for the file-size limit; the read side and the
 * not-ready refusal are in bankStatementOcrRead.ts, which both import.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { getImport, notReadyError } from './bankStatementOcrRead';
import { rowsToCommit } from './bankStatementDedupHelpers';
import { assertBankAccountInCompany } from './bankAccountGuard';
import { ocrBalanceColumns } from './bankStatementBalances';
import { ExtractionActionRefusedError } from './statementExtractionState';

export async function commitImport(
  companyId: string,
  importId: string,
  userId: string,
): Promise<{ inserted: number; skipped: number }> {
  // Locked first, so a concurrent commit waits here and then reads 'committed' — one batch row, one set of lines.
  await sql`SELECT 1 FROM bank_statement_imports WHERE id = ${importId}::uuid AND company_id = ${companyId} FOR UPDATE`;
  const imp = await getImport(companyId, importId);
  if (!imp) throw new ExtractionActionRefusedError('NOT_FOUND', 'Statement not found.'); // 404, before any write
  const notReady = notReadyError(imp.status);
  if (notReady) throw notReady;
  if (imp.status === 'committed') throw new Error('Import already committed');
  if (imp.status === 'rolled_back') throw new Error('Import has been rolled back');
  await assertBankAccountInCompany(companyId, imp.bankAccountId); // stored at upload: since deactivated, retyped, pre-guard?

  const { commit: nonDupes, rows } = await rowsToCommit(companyId, imp.bankAccountId, imp.rows); // ingest lock (WP2-2)
  log.info('bankStatementOcr: committing import', { importId, nonDupeCount: nonDupes.length }, 'bank-stmt-ocr');

  // Step 2 provenance: the batch the lines name (its id is this import's), recording as the importer the person who
  // UPLOADED the statement — whose file the lines are, and who may then not allocate them under enforcement (the
  // committer only confirms rows they cannot edit) — falling back to the committer, and the document's SHA-256.
  // Balances (998): the read's closing balance (with its opening) is stored as 'ai_read' — never 'printed', it is a
  // model's reading — only under ocrBalanceColumns' write rule (period read and ordered, every line inside it, a read
  // opening that adds up, a figure the column holds); otherwise 'unverified' with no figures; none read: 'not_in_file'.
  if (nonDupes.length > 0) {
    const balances = ocrBalanceColumns({
      periodStart: imp.periodStart, periodEnd: imp.periodEnd,
      openingBalance: imp.openingBalance, closingBalance: imp.closingBalance, rows: imp.rows,
    });
    await sql`
      INSERT INTO bank_import_batches (id, company_id, bank_account_id, statement_date, transaction_count,
        source_filename, imported_by, import_channel, file_sha256, opening_balance, closing_balance, balance_source)
      SELECT si.id, si.company_id, si.bank_account_id, COALESCE(si.period_end, ${nonDupes.map((r) => r.date).sort().at(-1)!}::DATE),
             ${nonDupes.length}, cd.file_name, COALESCE(si.created_by::TEXT, cd.uploaded_by::TEXT, ${userId}), 'statement_ocr',
             CASE WHEN cd.raw_bytes_sha256 ~ '^[0-9a-f]{64}$' THEN cd.raw_bytes_sha256 END,
             ${balances.openingBalance}::NUMERIC, ${balances.closingBalance}::NUMERIC, ${balances.balanceSource}
      FROM bank_statement_imports si
      LEFT JOIN captured_documents cd ON cd.id = si.source_document_id AND cd.company_id = si.company_id
      WHERE si.id = ${importId}::uuid AND si.company_id = ${companyId}::uuid
    `;
  }

  // Only a row that was really inserted counts: ON CONFLICT DO NOTHING skips one that already exists (a race with an
  // import that landed after the duplicate check), and counting it overstated the import and its batch.
  let insertedCount = 0;
  for (const row of nonDupes) {
    const written = (await sql`
      INSERT INTO bank_transactions (
        company_id, bank_account_id, transaction_date, amount,
        description, reference, status, import_batch_id
      ) VALUES (
        ${companyId}, ${imp.bankAccountId}::uuid, ${row.date}::date, ${row.amount},
        ${row.description}, ${row.reference ?? null}, 'imported', ${importId}::uuid
      )
      ON CONFLICT DO NOTHING
      RETURNING id
    `) as Array<{ id: string }>;
    insertedCount += written.length;
  }
  if (nonDupes.length > 0 && insertedCount !== nonDupes.length) {
    await sql`UPDATE bank_import_batches SET transaction_count = ${insertedCount} WHERE id = ${importId}::uuid AND company_id = ${companyId}::uuid`;
  }

  const skipped = imp.rows.length - insertedCount;

  await sql`
    UPDATE bank_statement_imports
    SET status = 'committed',
        imported_count = ${insertedCount},
        committed_at = NOW(), committed_by = ${userId}::uuid,
        extraction_summary = jsonb_set(extraction_summary, '{rows}', ${JSON.stringify(rows)}::jsonb), -- commit-time duplicates
        duplicate_count = ${rows.filter((r) => r.isDuplicate).length},
        updated_at = NOW()
    WHERE id = ${importId}::uuid AND company_id = ${companyId}
  `;

  log.info('bankStatementOcr: import committed', { importId, insertedCount, skipped }, 'bank-stmt-ocr');
  return { inserted: insertedCount, skipped };
}
