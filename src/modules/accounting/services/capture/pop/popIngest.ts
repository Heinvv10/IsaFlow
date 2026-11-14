/**
 * Files one PDF from a DKIM-trusted ABSA notice (absaPopTrust.ts) as a proof of payment:
 * a captured_documents row (document_type 'proof_of_payment', status 'processed', the read
 * fields as extracted_data), its bytes in storage, and its proof_of_payments row.
 *
 * No capture_event is created and no VLM read runs: the fields come from ABSA's own text
 * layer, and a POP is not a bill to post. A PDF that does not read as a complete notice is
 * NOT filed here; the caller hands it to the normal capture ingest so a person sees it.
 *
 * One row per ABSA transaction number. The document, its storage pointer and the POP row
 * are written in one transaction; the POP insert is ON CONFLICT DO NOTHING, and a conflict
 * (a concurrent scan filed it first) rolls the document back. A blob already uploaded for
 * the losing document stays in storage unreferenced (rare race, harmless).
 */
import type { Attachment } from 'mailparser';
import { sql, withTransaction } from '@/lib/neon';
import { sha256, storeCapturedBytes } from '@/lib/documentStorage';
import { isFileAlreadyCaptured } from '../capturedDocumentHash';
import { parseAbsaPopText, type AbsaPopReason } from './absaPopParser';
import { pdfText } from './pdfText';

type Row = Record<string, unknown>;

export type PopIngestResult =
  | { filed: true; documentId: string; popId: string }
  | { filed: false; reason: 'duplicate' }
  | { filed: false; reason: 'not_pdf' | 'unreadable_pdf' | AbsaPopReason };

const PDF_MAGIC = Buffer.from('%PDF-');

/** ABSA sends some notices as `*\/*`: the bytes, not the declared type, decide. */
export function isPdfBytes(content: Buffer): boolean {
  return content.length > PDF_MAGIC.length && content.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC);
}

class PopAlreadyFiled extends Error {}

export async function ingestAbsaPop(companyId: string, att: Attachment): Promise<PopIngestResult> {
  const content = att.content as Buffer;
  if (!isPdfBytes(content)) return { filed: false, reason: 'not_pdf' };
  const text = await pdfText(content);
  if (text === null) return { filed: false, reason: 'unreadable_pdf' };
  const parsed = parseAbsaPopText(text);
  if (!parsed.ok) return { filed: false, reason: parsed.reason };
  const pop = parsed.pop;

  const sha = sha256(content);
  const held = (await sql`
    SELECT 1 FROM proof_of_payments
    WHERE company_id = ${companyId}::uuid AND source = 'absa_notice'
      AND transaction_number = ${pop.transactionNumber}
    LIMIT 1
  `) as Row[];
  if (held.length > 0 || await isFileAlreadyCaptured(companyId, sha)) return { filed: false, reason: 'duplicate' };

  const amount = (pop.amountCents / 100).toFixed(2);
  try {
    return await withTransaction(async (tx) => {
      const [doc] = (await tx`
        INSERT INTO captured_documents (
          company_id, file_name, file_type, file_size, status, document_type,
          extracted_data, raw_bytes_sha256, raw_bytes_size
        ) VALUES (
          ${companyId}::uuid, ${`ABSA POP ${pop.transactionNumber}.pdf`}, 'application/pdf', ${content.length},
          'processed', 'proof_of_payment', ${JSON.stringify({ proofOfPayment: pop })}::jsonb,
          ${sha}, ${content.length}
        )
        RETURNING id
      `) as Row[];
      const documentId = String(doc!.id);
      const stored = await storeCapturedBytes(companyId, documentId, content, 'application/pdf');
      await tx`
        UPDATE captured_documents SET storage_bucket = ${stored.bucket}, storage_path = ${stored.path}
        WHERE id = ${documentId}::uuid AND company_id = ${companyId}::uuid
      `;
      const [row] = (await tx`
        INSERT INTO proof_of_payments (
          company_id, captured_document_id, source, transaction_number, payment_date, amount,
          beneficiary, beneficiary_bank, reference, payer_account_name
        ) VALUES (
          ${companyId}::uuid, ${documentId}::uuid, 'absa_notice', ${pop.transactionNumber}, ${pop.paymentDate}::date,
          ${amount}::numeric, ${pop.beneficiary}, ${pop.beneficiaryBank}, ${pop.reference}, ${pop.payerAccountName}
        )
        ON CONFLICT ON CONSTRAINT proof_of_payments_one_per_bank_txn DO NOTHING
        RETURNING id
      `) as Row[];
      if (!row) throw new PopAlreadyFiled();
      return { filed: true as const, documentId, popId: String(row.id) };
    });
  } catch (err) {
    if (err instanceof PopAlreadyFiled) return { filed: false, reason: 'duplicate' };
    throw err;
  }
}
