import type { TaggedSql, FindingsCollector } from './types';

/**
 * Pre-flight check: ensure the seed actually ran before running the
 * walkthrough. Without this, a silent seed failure produces a false PASS
 * against stale data from a prior run.
 *
 * On mismatch, records a FAIL finding AND exits the process — a soft
 * "log and continue" can't actually prevent downstream false-PASS verdicts
 * because the journeys would still query the (stale or missing) data.
 */
export async function assertSeedPresent(
  sql: TaggedSql, companyId: string, fc: FindingsCollector,
): Promise<boolean> {
  const counts = await sql`
    SELECT
      (SELECT count(*)::int FROM gl_accounts WHERE company_id = ${companyId}::uuid)             AS gl,
      (SELECT count(*)::int FROM customers WHERE company_id = ${companyId}::uuid AND notes LIKE 'QA-CUST-%') AS customers,
      (SELECT count(*)::int FROM practice_job_categories WHERE company_id = ${companyId}::uuid) AS categories,
      (SELECT count(*)::int FROM practice_work_items WHERE company_id = ${companyId}::uuid)     AS work_items,
      (SELECT count(*)::int FROM time_entries WHERE company_id = ${companyId}::uuid AND notes LIKE 'QA-TE-%') AS time_entries,
      (SELECT count(*)::int FROM customer_invoices WHERE company_id = ${companyId}::uuid AND invoice_number LIKE 'QA-INV-%') AS cust_invoices
  ` as Array<{ gl: number; customers: number; categories: number; work_items: number; time_entries: number; cust_invoices: number }>;

  const c = counts[0]!;
  const expected = { gl: 18, customers: 5, categories: 4, work_items: 9, time_entries: 8, cust_invoices: 8 };

  const mismatches: string[] = [];
  for (const [k, v] of Object.entries(expected)) {
    const actual = (c as Record<string, number>)[k] ?? 0;
    if (actual !== v) mismatches.push(`${k}: ${actual} (expected ${v})`);
  }

  fc.record({
    journey: 'preflight',
    step: 'seed_state_matches_expected',
    expected: 'all QA-prefixed counts match seed targets (run --reset + reseed if not)',
    actual: mismatches.length === 0 ? 'all counts match' : `mismatch: ${mismatches.join('; ')}`,
    verdict: mismatches.length === 0 ? 'PASS' : 'FAIL',
  });

  if (mismatches.length > 0) {
    console.error('\n[preflight] FAILED — seed state does not match expected counts.');
    console.error('             Run: QA_DESTRUCTIVE_OK=1 bunx tsx scripts/seed-qa-bookkeeping.ts --reset');
    process.exit(1);
  }
  return true;
}
