/**
 * Cycle 2: HTTP-level walkthrough against a live IsaFlow instance.
 *
 * Verifies the audit's UI-layer claims by calling the same API endpoints the
 * UI calls, with real auth cookies. If a query returns empty over HTTP when
 * cycle-1 (DB-direct) showed it had data, the bug is in the API/auth/RLS
 * layer. If both pass, the bug is in the React UI.
 *
 * Required env (no default for password — fail loudly if missing):
 *   QA_BASE_URL              — e.g. http://localhost:3101
 *   QA_ADMIN_EMAIL
 *   QA_ADMIN_PASSWORD
 *   COMPANY_ID_ISADEMO2      — set by provision-isademo2.ts
 */

import { loadDotenvLocal, getIsaDemo2CompanyId } from './_qa';
import { HttpClient, authAndSwitchCompany } from './qa-http/client';
import { HttpFindings } from './qa-http/types';
import {
  journeyWorkItems, journeyPracticeUsers,
  journeyPaymentValidation, journeyApprovalsFilter,
} from './qa-http/journeys';
import { writeHttpReports } from './qa-http/report';

loadDotenvLocal();

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`ERROR: ${name} is required. Set it in .env.local or pass on the command line.`);
    process.exit(1);
  }
  return v;
}

const BASE_URL = process.env.QA_BASE_URL ?? 'http://localhost:3101';
const EMAIL    = requireEnv('QA_ADMIN_EMAIL');
const PASSWORD = requireEnv('QA_ADMIN_PASSWORD');
const COMPANY_ID = getIsaDemo2CompanyId();

async function main(): Promise<void> {
  console.log('Cycle 2 HTTP walkthrough — IsaDemo2');
  const client = new HttpClient(BASE_URL);
  const fc = new HttpFindings();

  await authAndSwitchCompany(client, EMAIL, PASSWORD, COMPANY_ID);

  await journeyWorkItems(client, fc);
  await journeyPracticeUsers(client, fc);
  await journeyPaymentValidation(client, fc);
  await journeyApprovalsFilter(client, fc);

  const sum = fc.summary();
  console.log(`\nTotal: ${fc.all().length} | PASS=${sum.pass} FAIL=${sum.fail} INFO=${sum.info} BLOCKED=${sum.blocked}`);
  const { json, md } = writeHttpReports(fc.all(), sum, BASE_URL, COMPANY_ID);
  console.log(`\nReports:\n  ${json}\n  ${md}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
