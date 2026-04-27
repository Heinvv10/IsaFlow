/**
 * Seed IsaDemo2 with a realistic mid-month bookkeeper's inbox state.
 *
 * Designed so an agent can walk a full monthly close end-to-end and uncover
 * real workflow issues. Idempotent — keyed off QA- prefixed external refs.
 *
 * Modules under scripts/qa-seed/ own each section (COA, parties, practice,
 * transactions, reset). This file is just the wiring.
 *
 * Run with:
 *   bunx tsx scripts/seed-qa-bookkeeping.ts                                # seed (skip existing)
 *   QA_DESTRUCTIVE_OK=1 bunx tsx scripts/seed-qa-bookkeeping.ts --reset    # wipe QA records, reseed
 *
 * Requires: COMPANY_ID_ISADEMO2 in .env.local (set by provision-isademo2.ts).
 */

import { createSql, closeSql } from './_pg';
import { loadDotenvLocal, getDatabaseUrl, getIsaDemo2CompanyId } from './_qa';
import { seedCoa, seedBankAccount } from './qa-seed/coa';
import { seedCustomers, seedSuppliers } from './qa-seed/parties';
import {
  seedStaffRates, seedCategoriesAndWorkItems, seedPracticeClients,
  seedPracticeJob, seedTimeEntries,
} from './qa-seed/practice';
import {
  seedCustomerInvoices, seedSupplierInvoices, seedBankTransactions,
} from './qa-seed/transactions';
import { resetQaRecords } from './qa-seed/reset';

loadDotenvLocal();
const sql = createSql(getDatabaseUrl());
const COMPANY_ID = getIsaDemo2CompanyId();
const RESET = process.argv.includes('--reset');

async function getAdminUserId(): Promise<string> {
  const rows = await sql`
    SELECT user_id FROM company_users
    WHERE company_id = ${COMPANY_ID}::uuid
    ORDER BY (role = 'admin') DESC, created_at ASC
    LIMIT 1
  ` as Array<{ user_id: string }>;
  if (rows.length === 0) throw new Error('No users on IsaDemo2 — run provision-isademo2.ts');
  return rows[0]!.user_id;
}

async function summarize(): Promise<void> {
  const counts = await sql`
    SELECT
      (SELECT count(*) FROM gl_accounts             WHERE company_id = ${COMPANY_ID}::uuid) AS gl,
      (SELECT count(*) FROM bank_accounts           WHERE company_id = ${COMPANY_ID}::uuid) AS bank_accts,
      (SELECT count(*) FROM customers               WHERE company_id = ${COMPANY_ID}::uuid) AS customers,
      (SELECT count(*) FROM suppliers               WHERE company_id = ${COMPANY_ID}::uuid) AS suppliers,
      (SELECT count(*) FROM practice_clients        WHERE company_id = ${COMPANY_ID}::uuid) AS practice_clients,
      (SELECT count(*) FROM practice_job_categories WHERE company_id = ${COMPANY_ID}::uuid) AS categories,
      (SELECT count(*) FROM practice_work_items     WHERE company_id = ${COMPANY_ID}::uuid) AS work_items,
      (SELECT count(*) FROM practice_jobs           WHERE company_id = ${COMPANY_ID}::uuid) AS jobs,
      (SELECT count(*) FROM time_entries            WHERE company_id = ${COMPANY_ID}::uuid) AS time_entries,
      (SELECT count(*) FROM customer_invoices       WHERE company_id = ${COMPANY_ID}::uuid) AS cust_invoices,
      (SELECT count(*) FROM supplier_invoices       WHERE company_id = ${COMPANY_ID}::uuid) AS supp_invoices,
      (SELECT count(*) FROM bank_transactions       WHERE company_id = ${COMPANY_ID}::uuid) AS bank_txns
  ` as Array<Record<string, number>>;
  console.log('\n[summary]', counts[0]);
}

async function main(): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  console.log(`Seeding QA bookkeeping cycle into IsaDemo2 (${COMPANY_ID})...`);
  if (RESET) await resetQaRecords(sql, COMPANY_ID);

  const adminId = await getAdminUserId();
  console.log(`[admin_user] ${adminId}`);

  const coa       = await seedCoa(sql, COMPANY_ID);
  await seedBankAccount(sql, COMPANY_ID, coa);
  const customers = await seedCustomers(sql, COMPANY_ID);
  const suppliers = await seedSuppliers(sql, COMPANY_ID);

  await seedStaffRates(sql, COMPANY_ID);
  const workItems = await seedCategoriesAndWorkItems(sql, COMPANY_ID);
  const practiceClients = await seedPracticeClients(sql, COMPANY_ID, customers, adminId);

  const bookkeepingCatId = workItems.find((w) => w.catName === 'Bookkeeping')!.catId;
  const jobId = await seedPracticeJob(sql, COMPANY_ID, practiceClients[0]!, bookkeepingCatId, adminId);
  await seedTimeEntries(sql, COMPANY_ID, adminId, practiceClients[0]!, jobId, workItems);

  await seedCustomerInvoices(sql, COMPANY_ID, coa, customers, adminId);
  await seedSupplierInvoices(sql, COMPANY_ID, suppliers, adminId);
  await seedBankTransactions(sql, COMPANY_ID, coa.get('1110')!, customers);

  await summarize();
  console.log(`\nOK — IsaDemo2 seeded (today=${today}).`);
  console.log('     next: bunx tsx scripts/qa-walkthrough.ts');
}

main()
  .then(() => closeSql())
  .catch(async (e) => { console.error(e); await closeSql(); process.exit(1); });
