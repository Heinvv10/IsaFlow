/**
 * Bank Statement OCR Service — PRD-05 Phase 7
 *
 * Orchestrates: fetch PDF bytes → VLM extraction → dedup pass → persist
 * to bank_statement_imports → commit non-duplicate rows into bank_transactions.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { fetchRawBytes } from '@/lib/documentStorage';
import { extractBankStatementWithVlm } from './vlmBankService';
import { runDedupPass } from './bankStatementDedupHelpers';
import type { ExtractedBankStatement } from '@/modules/accounting/types/documentCapture.types';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface BankStatementRow {
  date: string;
  description: string;
  reference: string | null;
  amount: number;
  runningBalance: number | null;
  isDuplicate: boolean;
  duplicateOfBankTxId: string | null;
  duplicateMatchConfidence: number;
}

export interface BankStatementImport {
  id: string;
  companyId: string;
  bankAccountId: string;
  sourceDocumentId: string;
  periodStart: string | null;
  periodEnd: string | null;
  openingBalance: number | null;
  closingBalance: number | null;
  rowCount: number;
  importedCount: number;
  duplicateCount: number;
  status: 'extracted' | 'reviewing' | 'committed' | 'rolled_back';
  rows: BankStatementRow[];
  warnings: string[];
  createdAt: string;
  committedAt: string | null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

type DbRow = Record<string, unknown>;

function toDateStr(val: unknown): string | null {
  if (!val) return null;
  if (val instanceof Date) return val.toISOString().slice(0, 10);
  return String(val).slice(0, 10);
}

const MIME_MAP: Record<string, string> = {
  pdf: 'application/pdf',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  tiff: 'image/tiff',
};

function mapDbRow(row: DbRow): BankStatementImport {
  const summary = (row.extraction_summary ?? {}) as { rows?: BankStatementRow[]; warnings?: string[] };
  return {
    id: row.id as string,
    companyId: row.company_id as string,
    bankAccountId: row.bank_account_id as string,
    sourceDocumentId: row.source_document_id as string,
    periodStart: toDateStr(row.period_start),
    periodEnd: toDateStr(row.period_end),
    openingBalance: row.opening_balance != null ? Number(row.opening_balance) : null,
    closingBalance: row.closing_balance != null ? Number(row.closing_balance) : null,
    rowCount: Number(row.row_count ?? 0),
    importedCount: Number(row.imported_count ?? 0),
    duplicateCount: Number(row.duplicate_count ?? 0),
    status: row.status as BankStatementImport['status'],
    rows: summary.rows ?? [],
    warnings: summary.warnings ?? [],
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    committedAt: row.committed_at
      ? (row.committed_at instanceof Date ? row.committed_at.toISOString() : String(row.committed_at))
      : null,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function createImportFromDocument(
  companyId: string,
  bankAccountId: string,
  capturedDocumentId: string,
  userId: string,
): Promise<BankStatementImport> {
  log.info('bankStatementOcr: starting extraction', { companyId, capturedDocumentId }, 'bank-stmt-ocr');

  const raw = await fetchRawBytes(capturedDocumentId, companyId);
  if (!raw) throw new Error(`captured_documents row not found or no storage_path: ${capturedDocumentId}`);

  const base64 = raw.buffer.toString('base64');
  const mimeType = MIME_MAP[raw.fileType] ?? 'application/pdf';

  const extraction: ExtractedBankStatement | null = await extractBankStatementWithVlm(base64, mimeType);
  if (!extraction) throw new Error('VLM extraction returned null — check vLLM config');

  log.info('bankStatementOcr: extraction complete', {
    bankName: extraction.bankName,
    txCount: extraction.transactions.length,
    warnings: extraction.warnings.length,
  }, 'bank-stmt-ocr');

  const dedup = await runDedupPass(companyId, bankAccountId, extraction.transactions);

  const rows: BankStatementRow[] = extraction.transactions.map((tx, i) => ({
    date: tx.date ?? '',
    description: tx.description,
    reference: tx.reference ?? null,
    amount: tx.amount,
    runningBalance: tx.balance ?? null,
    isDuplicate: dedup[i]!.isDuplicate,
    duplicateOfBankTxId: dedup[i]!.duplicateOfBankTxId,
    duplicateMatchConfidence: dedup[i]!.duplicateMatchConfidence,
  }));

  const duplicateCount = rows.filter((r) => r.isDuplicate).length;
  const periodStart = extraction.statementPeriod?.from ?? null;
  const periodEnd = extraction.statementPeriod?.to ?? null;
  const extractionSummary = JSON.stringify({ rows, warnings: extraction.warnings });

  const inserted = (await sql`
    INSERT INTO bank_statement_imports (
      company_id, bank_account_id, source_document_id,
      period_start, period_end, opening_balance, closing_balance,
      row_count, imported_count, duplicate_count,
      status, extraction_summary, created_by
    ) VALUES (
      ${companyId}, ${bankAccountId}::uuid, ${capturedDocumentId}::uuid,
      ${periodStart}::date, ${periodEnd}::date,
      ${extraction.openingBalance ?? null}, ${extraction.closingBalance ?? null},
      ${rows.length}, 0, ${duplicateCount},
      'extracted', ${extractionSummary}::jsonb, ${userId}::uuid
    )
    RETURNING *
  `) as DbRow[];

  const result = mapDbRow(inserted[0]!);
  log.info('bankStatementOcr: import record created', {
    importId: result.id, rowCount: rows.length, duplicateCount,
  }, 'bank-stmt-ocr');
  return result;
}

export async function getImport(companyId: string, importId: string): Promise<BankStatementImport | null> {
  const rows = (await sql`
    SELECT * FROM bank_statement_imports
    WHERE id = ${importId}::uuid AND company_id = ${companyId}
    LIMIT 1
  `) as DbRow[];
  return rows[0] ? mapDbRow(rows[0]) : null;
}

export async function commitImport(
  companyId: string,
  importId: string,
  userId: string,
): Promise<{ inserted: number; skipped: number }> {
  const imp = await getImport(companyId, importId);
  if (!imp) throw new Error(`Import not found: ${importId}`);
  if (imp.status === 'committed') throw new Error('Import already committed');
  if (imp.status === 'rolled_back') throw new Error('Import has been rolled back');

  const nonDupes = imp.rows.filter((r) => !r.isDuplicate && r.date);
  log.info('bankStatementOcr: committing import', { importId, nonDupeCount: nonDupes.length }, 'bank-stmt-ocr');

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

export async function rollbackImport(companyId: string, importId: string, userId: string): Promise<void> {
  const imp = await getImport(companyId, importId);
  if (!imp) throw new Error(`Import not found: ${importId}`);
  if (imp.status === 'committed') throw new Error('Cannot roll back a committed import');

  await sql`
    UPDATE bank_statement_imports
    SET status = 'rolled_back', updated_at = NOW()
    WHERE id = ${importId}::uuid AND company_id = ${companyId}
  `;

  log.info('bankStatementOcr: import rolled back', { importId, userId }, 'bank-stmt-ocr');
}

export async function listImports(companyId: string, limit = 50): Promise<BankStatementImport[]> {
  const rows = (await sql`
    SELECT * FROM bank_statement_imports
    WHERE company_id = ${companyId}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `) as DbRow[];
  return rows.map(mapDbRow);
}
