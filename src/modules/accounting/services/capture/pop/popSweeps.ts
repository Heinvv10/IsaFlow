/**
 * The POP sweeps the mirror cron runs after its mail scan (pages/api/cron/mirror-scan.ts):
 * bank-line matching (popMatchSweep.ts) and the SharePoint copy (popArchiveSweep.ts), company by
 * company. Never throws: a failing sweep, or one company's, is logged and the scan's answer stands.
 */
import { log } from '@/lib/logger';
import { companiesWithOpenPops, emptyMatchSummary, sweepPopMatches, type PopMatchSummary } from './popMatchSweep';
import {
  anyArchiveTarget, companiesWithUnarchivedPops, emptyArchiveSummary, sweepPopArchive, type PopArchiveSummary,
} from './popArchiveSweep';
import { PopGraphClient, popArchiveCredentials, type FetchLike } from './popGraphClient';

export interface PopSweepTotals {
  match: PopMatchSummary;
  archive: PopArchiveSummary;
}

/** Matching may use at most this much of what is left, so the archive copy still gets a turn. */
export const POP_MATCH_SHARE_MS = 60_000;

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** `deadline` (epoch ms): the request's; no POP and no Graph call is started after it (popGraphClient). */
export async function runPopSweeps(opts: { deadline: number; fetchFn?: FetchLike; env?: NodeJS.ProcessEnv }): Promise<PopSweepTotals> {
  const totals: PopSweepTotals = { match: emptyMatchSummary(), archive: emptyArchiveSummary() };
  const matchUntil = Math.min(opts.deadline, Date.now() + POP_MATCH_SHARE_MS);
  try {
    for (const companyId of await companiesWithOpenPops()) {
      if (Date.now() >= matchUntil) break;
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
    const creds = popArchiveCredentials(opts.env);
    if (!creds) {
      // Silent when nothing is configured either; one warn per tick when a target exists without credentials.
      if (await anyArchiveTarget()) {
        log.warn('pop archive: pop_archive_targets has rows but POP_ARCHIVE_* is not set; nothing copied', {}, 'pop-archive');
      }
    } else {
      const graph = new PopGraphClient(creds, opts.fetchFn);
      for (const companyId of await companiesWithUnarchivedPops()) {
        if (Date.now() >= opts.deadline) break;
        try {
          const s = await sweepPopArchive(companyId, graph, undefined, opts.deadline);
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
