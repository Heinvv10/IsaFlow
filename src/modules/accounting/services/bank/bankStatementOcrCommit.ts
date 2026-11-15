/**
 * Commit of an AI-read statement import (bank_statement_imports → one bank_import_batches row + its lines).
 * Split out of bankStatementOcrService.ts (which re-exports it) for the file-size limit; the read side and the
 * not-ready refusal stay there.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { parsedDayWindowError } from '../../utils/journalDateWindow';
import { getImport, notReadyError } from './bankStatementOcrService';

export async function commitImport(
  companyId: string,
  importId: string,
  userId: string,
): Promise<{ inserted: number; skipped: number }> {
  // Locked first, so a concurrent commit waits here and then reads 'committed' — one batch row, one set of lines.
  await sql`SELECT 1 FROM bank_statement_imports WHERE id = ${importId}::uuid AND company_id = ${companyId} FOR UPDATE`;
  const imp = await getImport(companyId, importId);
  if (!imp) throw new Error(`Import not found: ${importId}`);
  const notReady = notReadyError(imp.status);
  if (notReady) throw notReady;
  if (imp.status === 'committed') throw new Error('Import already committed');
  if (imp.status === 'rolled_back') throw new Error('Import has been rolled back');

  const nonDupes = imp.rows.filter((r) => !r.isDuplicate && r.date && parsedDayWindowError(r.date) === null);
  log.info('bankStatementOcr: committing import', { importId, nonDupeCount: nonDupes.length }, 'bank-stmt-ocr');

  // Step 2 provenance: the batch the lines name (its id is this import's), recording as the importer the person who
  // UPLOADED the statement — whose file the lines are, and who may then not allocate them under enforcement (the
  // committer only confirms rows they cannot edit) — falling back to the committer, and the document's SHA-256.
  // Balances (998): the closing balance the read found is copied as 'printed' (with its opening), unchecked — a
  // misread shows in the bank page's Difference; none found is 'not_in_file'.
  if (nonDupes.length > 0) {
    await sql`
      INSERT INTO bank_import_batches (id, company_id, bank_account_id, statement_date, transaction_count,
        source_filename, imported_by, import_channel, file_sha256, opening_balance, closing_balance, balance_source)
      SELECT si.id, si.company_id, si.bank_account_id, COALESCE(si.period_end, ${nonDupes.map((r) => r.date).sort().at(-1)!}::DATE),
             ${nonDupes.length}, cd.file_name, COALESCE(si.created_by::TEXT, cd.uploaded_by::TEXT, ${userId}), 'statement_ocr',
             CASE WHEN cd.raw_bytes_sha256 ~ '^[0-9a-f]{64}$' THEN cd.raw_bytes_sha256 END,
             CASE WHEN si.closing_balance IS NOT NULL THEN si.opening_balance END, si.closing_balance,
             CASE WHEN si.closing_balance IS NOT NULL THEN 'printed' ELSE 'not_in_file' END
      FROM bank_statement_imports si
      LEFT JOIN captured_documents cd ON cd.id = si.source_document_id AND cd.company_id = si.company_id
      WHERE si.id = ${importId}::uuid AND si.company_id = ${companyId}::uuid
    `;
  }

  let insertedCount = 0;
  for (const row of nonDupes) {
    await sql`
      INSERT INTO bank_transactions (
        company_id, bank_account_id, transaction_date, amount,
        description, reference, status, import_batch_id
      ) VALUES (
        ${companyId}, ${imp.bankAccountId}::uuid, ${row.date}::date, ${row.amount},
        ${row.description}, ${row.reference ?? null}, 'imported', ${importId}::uuid
      )
      ON CONFLICT DO NOTHING
    `;
    insertedCount++;
  }

  const skipped = imp.rows.length - insertedCount;

  await sql`
    UPDATE bank_statement_imports
    SET status = 'committed',
        imported_count = ${insertedCount},
        committed_at = NOW(),
        committed_by = ${userId}::uuid,
        updated_at = NOW()
    WHERE id = ${importId}::uuid AND company_id = ${companyId}
  `;

  log.info('bankStatementOcr: import committed', { importId, insertedCount, skipped }, 'bank-stmt-ocr');
  return { inserted: insertedCount, skipped };
}
