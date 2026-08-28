// src/modules/accounting/services/afs/packSchedulerService.ts
import { log } from '@/lib/logger';
import { fmtDate } from '@/lib/fmtDate';
import { getCompaniesScheduledForDate } from './managementPackConfigService';
import { generateManagementPack } from './managementPackGeneratorService';

export interface SchedulerRunResult {
  date: string;
  dayOfMonth: number;
  period: string;
  companiesFound: number;
  succeeded: number;
  failed: number;
  errors: Array<{ companyId: string; error: string }>;
}

/**
 * Returns the prior completed month as 'YYYY-MM'.
 * Example: if today is 2026-04-05, returns '2026-03'.
 */
export function buildPriorMonthPeriod(date: Date): string {
  const year = date.getFullYear();
  const month = date.getMonth(); // 0-indexed — January is 0
  if (month === 0) {
    return `${year - 1}-12`;
  }
  return `${year}-${String(month).padStart(2, '0')}`;
}

/**
 * Called by the cron API route at 06:00 SAST.
 * Finds all companies scheduled to generate today and runs them in parallel.
 * Uses Promise.allSettled — one company failure does not block others.
 */
export async function runDailyScheduler(): Promise<SchedulerRunResult> {
  const today = new Date();
  const dayOfMonth = today.getDate();
  const period = buildPriorMonthPeriod(today);

  log.info('Running daily pack scheduler', { dayOfMonth, period }, 'packSchedulerService');

  const companies = await getCompaniesScheduledForDate(dayOfMonth);

  const results = await Promise.allSettled(
    companies.map(({ companyId, config }) =>
      generateManagementPack({ companyId, period, config, triggeredBy: 'cron' }),
    ),
  );

  const errors: Array<{ companyId: string; error: string }> = [];
  let succeeded = 0;
  let failed = 0;

  results.forEach((result, idx) => {
    const companyId = companies[idx]?.companyId ?? 'unknown';
    if (result.status === 'fulfilled') {
      succeeded++;
      log.info(
        'Pack generated',
        { companyId, period, documentId: result.value.documentId },
        'packSchedulerService',
      );
    } else {
      failed++;
      const errorMsg = result.reason instanceof Error ? result.reason.message : String(result.reason);
      errors.push({ companyId, error: errorMsg });
      log.error('Pack generation failed', { companyId, period, error: errorMsg }, 'packSchedulerService');
    }
  });

  const summary: SchedulerRunResult = {
    date: fmtDate(today),
    dayOfMonth,
    period,
    companiesFound: companies.length,
    succeeded,
    failed,
    errors,
  };

  log.info('Scheduler run complete', summary, 'packSchedulerService');
  return summary;
}
