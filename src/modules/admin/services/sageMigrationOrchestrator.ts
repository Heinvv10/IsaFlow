/**
 * sageMigrationOrchestrator.ts
 *
 * Drives one Sage migration commit: walks each pulled collection, calls the
 * per-entity commit functions in sageMigrationCommitService, and accumulates
 * the CommitSummary. Split out of that file so both stay under the 300-line
 * cap; the commit functions themselves did not move.
 */

import { sql, withSavepoint } from '@/lib/neon';
import { log } from '@/lib/logger';
import { commitARInvoice, commitAPInvoice, upsertCustomer, upsertSupplier } from './sageMigrationCommitService';
import type { Row, CommitPayload, CommitSummary } from './sageMigrationTypes';
import { sageAccountSubtype } from './sageAccountSubtype';
import { lockSystemRoleWrites } from '@/modules/accounting/services/gl/systemRoleWriteLock';
import { assertRolesKept, snapshotRoles } from '@/modules/accounting/services/gl/systemRoleInvariant';
import { clearSystemAccountCacheAfterCommit } from '@/modules/accounting/services/gl/systemAccountResolver';


export async function commitSageMigration(payload: CommitPayload): Promise<CommitSummary> {
  const { companyId, userId, pulled } = payload;

  const summary: CommitSummary = {
    accounts:         { created: 0, skipped: 0, failed: [] },
    customers:        { created: 0, skipped: 0, failed: [] },
    suppliers:        { created: 0, skipped: 0, failed: [] },
    arInvoices:       { created: 0, skipped: 0, failed: [] },
    apInvoices:       { created: 0, skipped: 0, failed: [] },
    warnings:         [],
  };

  // Per-record commits rollback to the savepoint on failure; the inner catch in
  // each loop body has already pushed a structured entry into `summary.*.failed`
  // and rethrown to trigger the rollback. Log once at this boundary so the
  // failure isn't completely silent in production.
  const sp = (name: string, fn: () => Promise<void>) =>
    withSavepoint(name, fn).catch((err: unknown) => {
      log.warn('sage commit: savepoint rolled back', {
        savepoint: name,
        error: err instanceof Error ? err.message : String(err),
      }, 'sage-migration');
    });

  // Chart of Accounts. The records may flag system accounts (role holders), so the writes run under the role-write lock
  // every other role writer takes, and end on the post-condition: every role held before still has exactly one usable
  // holder (a second flagged row would leave the resolver choosing by heap order). Today the rows it writes carry only
  // revenue / expense subtypes (sageAccountSubtype), so none can hold a role and nothing here fills the bank role; the lock
  // and the post-condition keep that true if the subtype mapping ever widens.
  const accountRecords = pulled.accounts?.records ?? [];
  if (accountRecords.length > 0) await lockSystemRoleWrites(companyId);
  const rolesBefore = accountRecords.length > 0 ? await snapshotRoles(companyId) : null;
  let ai = 0;
  for (const a of pulled.accounts?.records ?? []) {
    await sp(`acc_${ai++}`, async () => {
      try {
        const ins = (await sql`
          INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype, normal_balance, description, is_system_account, is_active, level, display_order)
          VALUES (${companyId}::UUID, ${a.accountCode}, ${a.accountName}, ${a.accountType}, ${sageAccountSubtype(a.accountType, a.category, a.accountName)}, ${a.normalBalance}, ${a.description ?? null}, ${a.isSystem ?? false}, ${a.isActive ?? true}, 0, 0)
          ON CONFLICT (company_id, account_code) DO NOTHING RETURNING id
        `) as Row[];
        if (ins.length) summary.accounts.created += 1; else summary.accounts.skipped += 1;
      } catch (err) {
        summary.accounts.failed.push(`${a.accountCode} ${a.accountName}: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
    });
  }

  if (rolesBefore) {
    await assertRolesKept(companyId, rolesBefore);
    clearSystemAccountCacheAfterCommit(companyId); // the resolver caches each holder
  }

  // Customers
  let i = 0;
  for (const c of pulled.customers?.records ?? []) {
    await sp(`cust_${i++}`, async () => {
      try {
        const existed = (await sql`SELECT 1 FROM customers WHERE company_id = ${companyId}::UUID AND LOWER(name) = LOWER(${c.name}) LIMIT 1`) as Row[];
        await upsertCustomer(companyId, c);
        if (existed.length) summary.customers.skipped += 1; else summary.customers.created += 1;
      } catch (err) {
        summary.customers.failed.push(`${c.name}: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
    });
  }

  // Suppliers
  i = 0;
  for (const s of pulled.suppliers?.records ?? []) {
    await sp(`supp_${i++}`, async () => {
      try {
        const existed = (await sql`SELECT 1 FROM suppliers WHERE company_id = ${companyId}::UUID AND LOWER(name) = LOWER(${s.name}) LIMIT 1`) as Row[];
        await upsertSupplier(companyId, s);
        if (existed.length) summary.suppliers.skipped += 1; else summary.suppliers.created += 1;
      } catch (err) {
        summary.suppliers.failed.push(`${s.name}: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
    });
  }

  // AR Invoices
  i = 0;
  for (const inv of pulled.arInvoices?.records ?? []) {
    await sp(`ar_${i++}`, async () => {
      try {
        const r = await commitARInvoice(companyId, userId, inv);
        if (r.created) summary.arInvoices.created += 1; else summary.arInvoices.skipped += 1;
        if (r.warning) summary.warnings.push(r.warning);
      } catch (err) {
        summary.arInvoices.failed.push(`${inv.invoiceNumber}: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
    });
  }

  // AP Invoices
  i = 0;
  for (const inv of pulled.apInvoices?.records ?? []) {
    await sp(`ap_${i++}`, async () => {
      try {
        const r = await commitAPInvoice(companyId, userId, inv);
        if (r.created) summary.apInvoices.created += 1; else summary.apInvoices.skipped += 1;
        if (r.warning) summary.warnings.push(r.warning);
      } catch (err) {
        summary.apInvoices.failed.push(`${inv.invoiceNumber}: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
    });
  }

  log.info('Sage commit complete', { companyId, summary }, 'migration');
  return summary;
}
