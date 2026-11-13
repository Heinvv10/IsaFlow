/**
 * Generate every active recurring journal's runs that fall due in one month (MCP run_recurring_journals).
 *
 * A loop over the ONE generator, `runRecurringJournal` — the UI's Generate — so every guard it has (due date, the
 * template's lines, dimensions, header accounts, fiscal period open or created, VAT lock, the claim) is the guard
 * here. Nothing is re-implemented: a refusal is whatever that function throws.
 *
 * EXACTLY ONCE PER OCCURRENCE. A run is claimed by advancing `next_run_date` under the template's row lock, so a
 * run already generated is simply no longer due: re-running a month creates nothing. Templates are locked in id
 * order (no deadlock between two runs), each lock held to the end of the request, and the schedule is re-read under
 * the lock before every occurrence — so a second run that waited on the first sees the advanced date and stops.
 *
 * ONE OCCURRENCE AT A TIME, IN ORDER. A run is due on `next_run_date`; a template whose next run falls before the
 * month is behind and is reported, not skipped forward (the earlier month is generated first). A run after today is
 * not due yet, as the UI says. A template that posts needs `canPost` (write:post); without it it is reported.
 *
 * REFUSALS. Each occurrence runs in its own savepoint. A refusal the generator raises (a caller-fixable state:
 * closed period, VAT lock, deactivated account, approval needed…) rolls back that occurrence only — the fiscal year
 * the period guard may have created included — and is reported; that template stops for this call, the others carry
 * on. Anything else is rethrown, so the request rolls back whole.
 *
 * DRY RUN. The same code, in a savepoint that is always rolled back (`inRolledBackSavepoint`): it meets every check
 * the live run meets and keeps nothing. Journal ids are dropped from its answer, since none survive.
 */
import { assertTxUsable } from '@/lib/als';
import { sql, withSavepoint } from '@/lib/neon';
import type { DbRow } from '@/types/db';
import { isJournalDateRefused } from '../../utils/journalDateWindow';
import { inRolledBackSavepoint } from '../core/rolledBackSavepoint';
import { isDimensionRefusal } from './dimensions/dimensionTypes';
import { isHeaderAccountRefusal } from './headerAccountGuard';
import { ClosedFiscalPeriodError } from './journalEntryPostingGuards';
import { VatPeriodLockedError } from './journalVatLockGuard';
import {
  RecurringJournalLockTimeoutError, RecurringJournalRequestError, businessToday, readTemplateForUpdate,
} from './recurringJournalGuards';
import { runRecurringJournal, type RecurringRunOptions } from './recurringJournalService';

export type RecurringSkipReason = 'not_yet_due' | 'behind_schedule' | 'needs_write_post' | 'refused' | 'contended';

export interface RecurringPeriodGenerated {
  templateId: string;
  templateName: string;
  runDate: string;
  /** Null on a dry run: nothing it minted survives. */
  journalId: string | null;
  posted: boolean;
  warnings?: string[];
}

export interface RecurringPeriodSkip {
  templateId: string;
  templateName: string;
  /** Null when the template could not be read (contended). */
  runDate: string | null;
  reason: RecurringSkipReason;
  message: string;
}

export interface RecurringPeriodRun {
  period: string;
  periodStart: string;
  periodEnd: string;
  generated: RecurringPeriodGenerated[];
  skipped: RecurringPeriodSkip[];
}

export interface RecurringPeriodRunOptions {
  /** The caller may post (MCP: write:post). A template that posts is reported, not run, without it. */
  canPost: boolean;
  dryRun: boolean;
  run: RecurringRunOptions;
}

const PERIOD = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** First and last day of a YYYY-MM month; null when it is not one. */
export function periodBounds(period: string): { start: string; end: string } | null {
  const m = PERIOD.exec(period);
  if (!m) return null;
  const lastDay = new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).getUTCDate();
  return { start: `${period}-01`, end: `${period}-${String(lastDay).padStart(2, '0')}` };
}

/** The generator's refusal text when `err` is one a caller can act on; null for anything else (rethrown). */
function refusalMessage(err: unknown): string | null {
  if (err instanceof RecurringJournalRequestError || err instanceof ClosedFiscalPeriodError
    || err instanceof VatPeriodLockedError || isDimensionRefusal(err) || isHeaderAccountRefusal(err)
    || isJournalDateRefused(err)) {
    return err.message;
  }
  return null;
}

async function execute(
  companyId: string, userId: string, period: string, bounds: { start: string; end: string },
  opts: RecurringPeriodRunOptions,
): Promise<RecurringPeriodRun> {
  const today = await businessToday();
  const templates = (await sql`
    SELECT id, template_name FROM recurring_journals
    WHERE company_id = ${companyId}::UUID AND status = 'active' AND next_run_date <= ${bounds.end}::DATE
    ORDER BY id
  `) as DbRow[];
  const generated: RecurringPeriodGenerated[] = [];
  const skipped: RecurringPeriodSkip[] = [];

  for (const t of templates) {
    const templateId = String(t.id);
    let templateName = String(t.template_name);
    const skip = (runDate: string | null, reason: RecurringSkipReason, message: string) => {
      skipped.push({ templateId, templateName, runDate, reason, message });
    };
    let previous: string | null = null;
    for (;;) {
      let row: DbRow | undefined;
      try {
        row = await readTemplateForUpdate(companyId, templateId);
      } catch (err) {
        if (!(err instanceof RecurringJournalLockTimeoutError)) throw err;
        skip(null, 'contended', err.message);
        break;
      }
      if (!row || row.status !== 'active') break; // paused, cancelled or completed by the time it was locked
      templateName = String(row.template_name);
      const runDate = String(row.next_run_date);
      // The claim advances next_run_date; one that did not would generate the same run again, for ever.
      if (previous !== null && runDate <= previous) {
        throw new Error(`Recurring journal ${templateId} did not advance past ${previous}`);
      }
      if (runDate > bounds.end) break;
      if (runDate < bounds.start) {
        skip(runDate, 'behind_schedule', `Its next run is ${runDate}, before ${period}. Runs are generated in order: `
          + `run ${runDate.slice(0, 7)} first.`);
        break;
      }
      if (runDate > today) {
        skip(runDate, 'not_yet_due', `Not due until ${runDate} (today is ${today}).`);
        break;
      }
      if (row.auto_post !== false && !opts.canPost) {
        skip(runDate, 'needs_write_post', 'This template posts its journals, which needs the "Post to ledger" '
          + 'permission (write:post). Nothing was generated for it.');
        break;
      }
      try {
        const run = await withSavepoint('recurring_period_run', () =>
          runRecurringJournal(companyId, templateId, userId, opts.run));
        generated.push({
          templateId, templateName, runDate, journalId: run.journalId, posted: run.posted,
          ...(run.warnings ? { warnings: run.warnings } : {}),
        });
      } catch (err) {
        const message = refusalMessage(err);
        if (message === null) throw err;
        assertTxUsable(); // the savepoint rolled back cleanly, or this rethrows
        skip(runDate, 'refused', message);
        break;
      }
      previous = runDate;
    }
  }
  return { period, periodStart: bounds.start, periodEnd: bounds.end, generated, skipped };
}

/** Generate (or, `dryRun`, preview) the month's due runs of every active template. Request transaction only. */
export async function runRecurringJournalsForPeriod(
  companyId: string, userId: string, period: string, opts: RecurringPeriodRunOptions,
): Promise<RecurringPeriodRun> {
  const bounds = periodBounds(period);
  if (!bounds) throw new RecurringJournalRequestError(`period must be a month, YYYY-MM (got ${JSON.stringify(period)})`);
  if (!opts.dryRun) return execute(companyId, userId, period, bounds, opts);
  let preview: RecurringPeriodRun | undefined;
  await inRolledBackSavepoint('recurring_period_dry_run', async () => {
    preview = await execute(companyId, userId, period, bounds, opts);
  });
  const result = preview!;
  return { ...result, generated: result.generated.map((g) => ({ ...g, journalId: null })) };
}
