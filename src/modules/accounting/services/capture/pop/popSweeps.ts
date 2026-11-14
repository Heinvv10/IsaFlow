/**
 * The POP sweeps the mirror cron runs after its mail scan (pages/api/cron/mirror-scan.ts):
 * bank-line matching (popMatchSweep.ts) and the SharePoint copy (popArchiveSweep.ts), company by
 * company. Never throws: a failing sweep, or one company's, is logged and the scan's answer stands.
 */
import { log } from '@/lib/logger';
import { companiesWithOpenPops, sweepPopMatches, type PopMatchSummary } from './popMatchSweep';
import { companiesWithUnarchivedPops, sweepPopArchive, type PopArchiveSummary } from './popArchiveSweep';
import { PopGraphClient, popArchiveCredentials, type FetchLike } from './popGraphClient';

export interface PopSweepTotals {
  match: PopMatchSummary;
  archive: PopArchiveSummary;
}

/**
 * The sweeps' share of the tick. The cron's curl gives the whole request 300 s and each mail scan may
 * take 120 s, so each sweep starts no new POP after this; what is left goes next tick.
 */
export const POP_SWEEP_BUDGET_MS = 60_000;

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export async function runPopSweeps(opts: { fetchFn?: FetchLike; env?: NodeJS.ProcessEnv } = {}): Promise<PopSweepTotals> {
  const totals: PopSweepTotals = {
    match: { checked: 0, attached: 0, ambiguous: 0, notFound: 0, refused: 0, errors: 0 },
    archive: { archived: 0, tooLarge: 0, failed: 0 },
  };
  const matchUntil = Date.now() + POP_SWEEP_BUDGET_MS;
  try {
    for (const companyId of await companiesWithOpenPops()) {
      try {
        const s = await sweepPopMatches(companyId, undefined, matchUntil);
        for (const k of Object.keys(s) as (keyof PopMatchSummary)[]) totals.match[k] += s[k];
      } catch (err) {
        totals.match.errors += 1;
        log.warn('pop match sweep failed for a company', { companyId, error: message(err) }, 'pop-match');
      }
    }
  } catch (err) {
    totals.match.errors += 1;
    log.warn('pop match sweep failed', { error: message(err) }, 'pop-match');
  }

  try {
    const companies = await companiesWithUnarchivedPops();
    const creds = popArchiveCredentials(opts.env);
    if (!creds) {
      if (companies.length > 0) {
        log.warn('pop archive: POP_ARCHIVE_* credentials are not set; nothing copied', { companies: companies.length }, 'pop-archive');
      }
    } else {
      const graph = new PopGraphClient(creds, opts.fetchFn);
      const archiveUntil = Date.now() + POP_SWEEP_BUDGET_MS;
      for (const companyId of companies) {
        try {
          const s = await sweepPopArchive(companyId, graph, undefined, archiveUntil);
          for (const k of Object.keys(s) as (keyof PopArchiveSummary)[]) totals.archive[k] += s[k];
        } catch (err) {
          totals.archive.failed += 1;
          log.warn('pop archive sweep failed for a company', { companyId, error: message(err) }, 'pop-archive');
        }
      }
    }
  } catch (err) {
    totals.archive.failed += 1;
    log.warn('pop archive sweep failed', { error: message(err) }, 'pop-archive');
  }
  return totals;
}
