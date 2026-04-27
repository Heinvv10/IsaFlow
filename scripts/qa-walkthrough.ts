/**
 * Cycle 1 walkthrough harness for IsaDemo2.
 *
 * Walks named accountant journeys against the seeded tenant by running the
 * SAME queries the production API endpoints use. If a query returns rows
 * here, the data is queryable -> bug is in the UI/handler layer. If empty,
 * the seed (or schema) is wrong, not the UI.
 *
 * Modules under scripts/qa-walk/ own each section. This file is wiring.
 *
 * Run with: bunx tsx scripts/qa-walkthrough.ts
 * Reports: qa-reports/run-{ts}.json + qa-reports/run-{ts}.md
 */

import { createSql, closeSql } from './_pg';
import { loadDotenvLocal, getDatabaseUrl, getIsaDemo2CompanyId } from './_qa';
import { FindingsCollector } from './qa-walk/types';
import { assertSeedPresent } from './qa-walk/seed-verify';
import {
  journeySetupHealth, journeyTimeEntry, journeyRateOverrides,
  journeyInvoicePayment, journeyApprovals, journeyWip, journeyBankRec,
} from './qa-walk/journeys';
import { writeReports } from './qa-walk/report';

loadDotenvLocal();
const sql = createSql(getDatabaseUrl());
const COMPANY_ID = getIsaDemo2CompanyId();

async function main(): Promise<void> {
  console.log(`QA walkthrough — IsaDemo2 (${COMPANY_ID})`);
  const fc = new FindingsCollector();

  console.log('\n[preflight] verify seed state');
  const ok = await assertSeedPresent(sql, COMPANY_ID, fc);
  if (!ok) {
    console.error('\n[preflight] FAILED — seed state does not match expected counts. Run:');
    console.error('  QA_DESTRUCTIVE_OK=1 bunx tsx scripts/seed-qa-bookkeeping.ts --reset');
  }

  await journeySetupHealth(sql, COMPANY_ID, fc);
  await journeyTimeEntry(sql, COMPANY_ID, fc);
  await journeyRateOverrides(sql, COMPANY_ID, fc);
  await journeyInvoicePayment(sql, COMPANY_ID, fc);
  await journeyApprovals(sql, COMPANY_ID, fc);
  await journeyWip(sql, COMPANY_ID, fc);
  await journeyBankRec(sql, COMPANY_ID, fc);

  const sum = fc.summary();
  console.log(`\nTotal: ${fc.all().length} | PASS=${sum.pass} FAIL=${sum.fail} INFO=${sum.info} BLOCKED=${sum.blocked}`);
  const { json, md } = writeReports(fc.all(), sum, COMPANY_ID);
  console.log(`\nReports:\n  ${json}\n  ${md}`);
}

main()
  .then(() => closeSql())
  .catch(async (e) => { console.error(e); await closeSql(); process.exit(1); });
