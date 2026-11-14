/**
 * POP inbox phase 1 step 4: copy each filed POP's PDF to the company's SharePoint folder (migration 992),
 * from the mirror cron (popSweeps.ts), as the cron's role. Bounded: POP_ARCHIVE_BATCH POPs per company per
 * tick, never-tried first then least recently tried, none started after the caller's deadline.
 *
 * A POP is settled once in pop_archive_copies: 'archived' (the drive item, or after a 409 an existing file
 * whose bytes are ours), 'too_large' (over Graph's 4 MB simple upload), or 'failed' after POP_ARCHIVE_MAX_ATTEMPTS
 * failures of its own (no path, no bytes, Graph refused this file, a 403 on it, an existing file that differs).
 * Every failure is a try in pop_archive_attempts: the POP goes behind the others and waits 5 min doubling (at
 * most 24 h). An outage (Graph 5xx, the network, storage) is a try that never counts toward 'failed', and a 5xx
 * or network failure ends the company's tick. Throttling (429, 503 + Retry-After), a 401, a token failure, a
 * second POP denied (403) in one tick (the app's grant) and the deadline end the tick and count against no POP.
 */
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { fetchRawBytes } from '@/lib/documentStorage';
import { encodeDrivePath, popArchivePath } from './popArchiveName';
import { GraphTokenError, MAX_SIMPLE_UPLOAD_BYTES, type PopGraphClient } from './popGraphClient';

type Row = Record<string, unknown>;

export const POP_ARCHIVE_BATCH = 25;
/** After this many failed attempts a POP is settled as 'failed' for a person (popArchiveSweep header). */
export const POP_ARCHIVE_MAX_ATTEMPTS = 10;

export interface PopArchiveSummary {
  archived: number;
  tooLarge: number;
  failed: number;
  /** The company's sweep ended early this tick (throttled, denied, no token, deadline, Graph unwell). */
  stopped: number;
}

export const emptyArchiveSummary = (): PopArchiveSummary => ({ archived: 0, tooLarge: 0, failed: 0, stopped: 0 });

/** Companies with an archive target and at least one POP not yet settled. */
export async function companiesWithUnarchivedPops(): Promise<string[]> {
  const rows = (await sql`
    SELECT t.company_id FROM pop_archive_targets t
    WHERE EXISTS (SELECT 1 FROM proof_of_payments p WHERE p.company_id = t.company_id
      AND NOT EXISTS (SELECT 1 FROM pop_archive_copies c WHERE c.proof_of_payment_id = p.id AND c.company_id = p.company_id))
  `) as Row[];
  return rows.map((r) => String(r.company_id));
}

/** Whether any company has an archive target (the sweep says so when the credentials are missing). */
export async function anyArchiveTarget(): Promise<boolean> {
  const [r] = (await sql`SELECT EXISTS (SELECT 1 FROM pop_archive_targets) AS any`) as Row[];
  return r?.any === true;
}

export async function sweepPopArchive(companyId: string, graph: PopGraphClient, limit: number = POP_ARCHIVE_BATCH,
  deadline: number = Number.POSITIVE_INFINITY): Promise<PopArchiveSummary> {
  const summary = emptyArchiveSummary();
  const [target] = (await sql`
    SELECT site_id, folder_path FROM pop_archive_targets WHERE company_id = ${companyId}::uuid
  `) as Row[];
  if (!target) return summary;

  const pops = (await sql`
    SELECT p.id, p.captured_document_id, p.payment_date::text AS payment_date, p.amount::text AS amount,
           p.beneficiary, p.transaction_number
    FROM proof_of_payments p
    LEFT JOIN pop_archive_attempts a ON a.proof_of_payment_id = p.id AND a.company_id = p.company_id
    WHERE p.company_id = ${companyId}::uuid
      AND NOT EXISTS (SELECT 1 FROM pop_archive_copies c WHERE c.proof_of_payment_id = p.id AND c.company_id = p.company_id)
      AND (a.id IS NULL OR a.last_attempt_at
        <= now() - least(interval '5 minutes' * power(2, a.tries - 1), interval '24 hours'))
    ORDER BY a.last_attempt_at NULLS FIRST, p.created_at, p.id
    LIMIT ${limit}::int
  `) as Row[];

  let denied = 0; // POPs denied this tick: one is that file, a second is the app's grant
  for (const pop of pops) {
    if (Date.now() >= deadline) { summary.stopped += 1; break; }
    const popId = String(pop.id);
    let path: string;
    try {
      path = popArchivePath(String(target.folder_path), {
        paymentDate: String(pop.payment_date), beneficiary: String(pop.beneficiary),
        amount: String(pop.amount), transactionNumber: String(pop.transaction_number),
      });
    } catch (err) {
      await recordFailure(companyId, popId, null, err instanceof Error ? err.message : String(err), 'counted', summary);
      continue;
    }
    try {
      const raw = await fetchRawBytes(String(pop.captured_document_id), companyId);
      if (!raw) {
        await recordFailure(companyId, popId, path, 'PDF bytes unavailable', 'counted', summary);
        continue;
      }
      if (raw.buffer.length > MAX_SIMPLE_UPLOAD_BYTES) {
        await recordCopy(companyId, popId, 'too_large', null, null, path);
        summary.tooLarge += 1;
        log.warn('pop archive: PDF over the 4 MB upload limit; not copied', { companyId, popId, size: raw.buffer.length }, 'pop-archive');
        continue;
      }
      const up = await graph.uploadNew(String(target.site_id), encodeDrivePath(path), raw.buffer, deadline);
      if (up.kind === 'ok') {
        await recordCopy(companyId, popId, 'archived', up.driveItemId, up.webUrl, path);
        summary.archived += 1;
        log.info('pop archived to SharePoint', { companyId, popId, existed: up.existed }, 'pop-archive');
        continue;
      }
      if (up.kind === 'failed') {
        await recordFailure(companyId, popId, path, `HTTP ${up.status}: ${up.detail}`, up.transient ? 'outage' : 'counted', summary);
        if (!up.transient) continue;
      } else if (up.kind === 'denied' && up.status === 403 && denied === 0) {
        // One file can be denied (its folder's permissions): counted against it. A second POP denied in the same
        // tick is the app's grant: the tick ends there, counted against no POP.
        denied += 1;
        await recordFailure(companyId, popId, path, `HTTP ${up.status}: denied`, 'counted', summary);
        continue;
      }
      summary.stopped += 1;
      log.warn('pop archive: stopped for this tick', { companyId, popId, result: up }, 'pop-archive');
      break;
    } catch (err) {
      if (err instanceof GraphTokenError) {
        summary.stopped += 1;
        log.warn('pop archive: no Graph token; stopped for this tick', { companyId, error: err.message }, 'pop-archive');
        break;
      }
      // Storage or the database, not this POP: a try that does not count toward 'failed'.
      await recordFailure(companyId, popId, path, err instanceof Error ? err.message : String(err), 'outage', summary).catch((e: unknown) => {
        log.error('pop archive: failure not recorded', { companyId, popId, error: String(e) }, 'pop-archive');
      });
    }
  }
  return summary;
}

/**
 * A failed try: it moves the POP behind the others and waits (backoff by `tries`). A 'counted' failure (this POP's
 * own) also counts an attempt, and the POP_ARCHIVE_MAX_ATTEMPTS-th settles it 'failed'; an 'outage' (Graph 5xx, the
 * network, storage) never does.
 */
async function recordFailure(companyId: string, popId: string, path: string | null, error: string,
  kind: 'counted' | 'outage', summary: PopArchiveSummary): Promise<void> {
  summary.failed += 1;
  const counted = kind === 'counted' ? 1 : 0;
  const [row] = (await sql`
    INSERT INTO pop_archive_attempts (company_id, proof_of_payment_id, attempts, last_error)
    VALUES (${companyId}::uuid, ${popId}::uuid, ${counted}::int, ${error.slice(0, 300)})
    ON CONFLICT ON CONSTRAINT pop_archive_attempts_one_per_pop DO UPDATE
      SET attempts = pop_archive_attempts.attempts + ${counted}::int, tries = pop_archive_attempts.tries + 1,
          last_attempt_at = now(), last_error = EXCLUDED.last_error
    RETURNING attempts
  `) as Row[];
  const attempts = Number(row?.attempts ?? 0);
  log.warn('pop archive: try failed', { companyId, popId, kind, attempts, error }, 'pop-archive');
  if (attempts >= POP_ARCHIVE_MAX_ATTEMPTS) await recordCopy(companyId, popId, 'failed', null, null, path);
}

async function recordCopy(companyId: string, popId: string, outcome: 'archived' | 'too_large' | 'failed',
  driveItemId: string | null, webUrl: string | null, path: string | null): Promise<void> {
  await sql`
    INSERT INTO pop_archive_copies (company_id, proof_of_payment_id, outcome, drive_item_id, web_url, path)
    VALUES (${companyId}::uuid, ${popId}::uuid, ${outcome}, ${driveItemId}, ${webUrl}, ${path})
    ON CONFLICT ON CONSTRAINT pop_archive_copies_one_per_pop DO NOTHING
  `;
}
