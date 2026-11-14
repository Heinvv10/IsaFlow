/**
 * POP inbox phase 1 step 4: copy each filed POP's PDF to the company's SharePoint folder (migration 992),
 * from the mirror cron (popSweeps.ts), as the cron's role. Bounded: POP_ARCHIVE_BATCH uploads per company
 * per tick, oldest POP first.
 *
 * A POP is copied once: pop_archive_copies (one row per POP) records the drive item, or 'too_large' for a
 * PDF over Graph's 4 MB simple-upload limit (never retried). A 409 (the name exists) reads that item and
 * records it. Any other failure (no bytes, Graph down, refused) records nothing: next tick retries it.
 * No credentials (POP_ARCHIVE_*) or no pop_archive_targets row: nothing happens for that company.
 */
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { fetchRawBytes } from '@/lib/documentStorage';
import { encodeDrivePath, popArchivePath } from './popArchiveName';
import { MAX_SIMPLE_UPLOAD_BYTES, type PopGraphClient } from './popGraphClient';

type Row = Record<string, unknown>;

export const POP_ARCHIVE_BATCH = 25;

export interface PopArchiveSummary {
  archived: number;
  tooLarge: number;
  failed: number;
}

/** Companies with an archive target and at least one POP not yet copied. */
export async function companiesWithUnarchivedPops(): Promise<string[]> {
  const rows = (await sql`
    SELECT t.company_id FROM pop_archive_targets t
    WHERE EXISTS (SELECT 1 FROM proof_of_payments p WHERE p.company_id = t.company_id
      AND NOT EXISTS (SELECT 1 FROM pop_archive_copies c WHERE c.proof_of_payment_id = p.id AND c.company_id = p.company_id))
  `) as Row[];
  return rows.map((r) => String(r.company_id));
}

/** `until` (epoch ms): no upload is started after it; the rest wait for the next tick. */
export async function sweepPopArchive(companyId: string, graph: PopGraphClient, limit: number = POP_ARCHIVE_BATCH,
  until: number = Number.POSITIVE_INFINITY): Promise<PopArchiveSummary> {
  const summary: PopArchiveSummary = { archived: 0, tooLarge: 0, failed: 0 };
  const [target] = (await sql`
    SELECT site_id, folder_path FROM pop_archive_targets WHERE company_id = ${companyId}::uuid
  `) as Row[];
  if (!target) return summary;

  const pops = (await sql`
    SELECT p.id, p.captured_document_id, p.payment_date::text AS payment_date, p.amount::text AS amount,
           p.beneficiary, p.transaction_number
    FROM proof_of_payments p
    WHERE p.company_id = ${companyId}::uuid
      AND NOT EXISTS (SELECT 1 FROM pop_archive_copies c WHERE c.proof_of_payment_id = p.id AND c.company_id = p.company_id)
    ORDER BY p.created_at, p.id
    LIMIT ${limit}::int
  `) as Row[];

  for (const pop of pops) {
    if (Date.now() >= until) break;
    const popId = String(pop.id);
    try {
      const path = popArchivePath(String(target.folder_path), {
        paymentDate: String(pop.payment_date), beneficiary: String(pop.beneficiary),
        amount: String(pop.amount), transactionNumber: String(pop.transaction_number),
      });
      const raw = await fetchRawBytes(String(pop.captured_document_id), companyId);
      if (!raw) {
        summary.failed += 1;
        log.warn('pop archive: the PDF bytes are unavailable; retried next tick', { companyId, popId }, 'pop-archive');
        continue;
      }
      if (raw.buffer.length > MAX_SIMPLE_UPLOAD_BYTES) {
        await recordCopy(companyId, popId, 'too_large', null, null, path);
        summary.tooLarge += 1;
        log.warn('pop archive: PDF over the 4 MB upload limit; not copied', { companyId, popId, size: raw.buffer.length }, 'pop-archive');
        continue;
      }
      const up = await graph.uploadNew(String(target.site_id), encodeDrivePath(path), raw.buffer);
      if (!up.ok) {
        summary.failed += 1;
        log.warn('pop archive: upload failed; retried next tick', { companyId, popId, status: up.status, detail: up.detail }, 'pop-archive');
        continue;
      }
      await recordCopy(companyId, popId, 'archived', up.driveItemId, up.webUrl, path);
      summary.archived += 1;
      log.info('pop archived to SharePoint', { companyId, popId, existed: up.existed }, 'pop-archive');
    } catch (err) {
      summary.failed += 1;
      log.warn('pop archive failed; retried next tick', {
        companyId, popId, error: err instanceof Error ? err.message : String(err),
      }, 'pop-archive');
    }
  }
  return summary;
}

async function recordCopy(companyId: string, popId: string, outcome: 'archived' | 'too_large',
  driveItemId: string | null, webUrl: string | null, path: string): Promise<void> {
  await sql`
    INSERT INTO pop_archive_copies (company_id, proof_of_payment_id, outcome, drive_item_id, web_url, path)
    VALUES (${companyId}::uuid, ${popId}::uuid, ${outcome}, ${driveItemId}, ${webUrl}, ${path})
    ON CONFLICT ON CONSTRAINT pop_archive_copies_one_per_pop DO NOTHING
  `;
}
