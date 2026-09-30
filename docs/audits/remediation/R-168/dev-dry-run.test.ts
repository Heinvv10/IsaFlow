// R-168 dev dry run: both practice crons against isaflow_dev, on a pool whose
// every transaction is READ ONLY (default_transaction_read_only=on in the URL),
// with the mailer mocked. Nothing is sent and nothing can be written.
// Run with docs/audits/remediation/R-168/dev-dry-run.config.ts (see fix.md).
import { it, expect, vi } from 'vitest';

const sent = vi.hoisted(() => [] as string[]);
vi.mock('@/modules/accounting/services/core/emailService', () => ({
  sendEmail: vi.fn(async (o: { to: string }) => { sent.push(o.to); return { success: true }; }),
}));

import { sendEmail } from '@/modules/accounting/services/core/emailService';
import { getPool } from '@/lib/neon';
import { runMonthlyReports } from '@/modules/accounting/services/practice/practiceMonthlyReportService';
import { sweepRecurringTasks } from '@/modules/accounting/services/practice/practiceRecurringTaskService';

it('R-168 dev dry run (read-only, mailer mocked)', async () => {
  expect(vi.isMockFunction(sendEmail)).toBe(true);
  const { rows } = await getPool().query(
    "SELECT current_database() AS db, current_setting('default_transaction_read_only') AS ro");
  expect(rows[0]).toEqual({ db: 'isaflow_dev', ro: 'on' });

  const monthly = await runMonthlyReports('2026-08');
  const sweep = await sweepRecurringTasks();
  process.stdout.write(`${JSON.stringify({ monthly, mailerCalls: sent.length, sweep }, null, 2)}\n`);
  expect(monthly.errors).toEqual([]);
  expect(sweep.errors).toEqual([]);
}, 600_000);
