/**
 * Shared by the approved-batch digest suites (migration 922): a company that can pay, one DRAFT batch, the real
 * approve / file / send routes, and the supplier writer that changes a payee's bank details.
 */
import type { Pool } from 'pg';
import { expect } from 'vitest';
import eftGenerate from '../../pages/api/accounting/eft-generate';
import netcashSubmit from '../../pages/api/accounting/netcash/submit';
import { updateSupplier } from '@/modules/accounting/services/core/supplierWriteService';
import { callRoute, plantRule } from './r035-approval.helpers';
import { dataOf } from './r035-pr2.helpers';
import { enforcePay, inRequest, payCompany, payRoutes, plantBatch } from './r035-pr5.helpers';

export const NEW_ACCOUNT = '62000007777';
export const OLD_ACCOUNT = '62000000001'; // plantSupplier's
export const CHANGED = 'BATCH_CHANGED_SINCE_APPROVAL';

export function digestKit(pool: Pool, u: { a: string; b: string }, tokens: Record<string, string>, companies: string[]) {
  const r = payRoutes(tokens);
  const eft = (c: string, batchId: string) =>
    callRoute(eftGenerate, tokens[u.a]!, c, 'POST', { batchId, bank: 'fnb' }, '/api/accounting/eft-generate');
  return {
    r,
    eft,
    netcash: (c: string, batchPaymentId: string) =>
      callRoute(netcashSubmit, tokens[u.a]!, c, 'POST', { batchPaymentId }, '/api/accounting/netcash/submit'),
    /** A company that can pay (Netcash configured), one DRAFT batch of two members; enforcement off unless `enforced`. */
    async fixture(enforced = false) {
      const { company: c, bank } = await payCompany(pool, [[u.a, 'admin'], [u.b, 'owner']], companies);
      await pool.query("UPDATE companies SET netcash_enabled = true, netcash_service_key = 'k', netcash_payouts_key = 'k' WHERE id = $1", [c]);
      if (enforced) {
        for (const type of ['supplier_payment', 'payment_batch'] as const) await plantRule(pool, c, 'owner', { documentType: type });
        await enforcePay(pool, c, 'payment_batch', u.b);
      }
      const b = await plantBatch(pool, c, u.a, bank);
      return { c, b, supplierId: b.members[0]!.supplierId };
    },
    /** The batch approved through the real route by `by`. */
    async approve(c: string, batchId: string, by = u.a) {
      const res = await r.batch(by, c, 'approve', batchId);
      expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    },
    /** A payee's bank account changed by the real supplier writer, on its own committed request transaction. */
    changeBank: (c: string, supplierId: string, account = NEW_ACCOUNT) =>
      inRequest(pool, u.a, c, () => updateSupplier(c, supplierId, { bankAccountNumber: account }, u.a)),
    submissions: async (c: string) =>
      (await pool.query('SELECT count(*)::INT AS n FROM netcash_submissions WHERE company_id = $1', [c])).rows[0].n as number,
    exportRecords: async (batchId: string) => (await pool.query(
      "SELECT count(*)::INT AS n FROM audit_log WHERE entity_type = 'batch_bank_file' AND entity_id = $1", [batchId])).rows[0].n as number,
    storedDigest: async (batchId: string) => (await pool.query(
      'SELECT approved_digest FROM supplier_payment_batches WHERE id = $1', [batchId])).rows[0].approved_digest as string | null,
    approvers: async (batchId: string) => (await pool.query(
      'SELECT DISTINCT approved_by::TEXT AS a FROM supplier_payments WHERE batch_id = $1', [batchId])).rows.map((x) => x.a as string),
    contentOf: (res: Awaited<ReturnType<typeof eft>>) => dataOf<{ content: string }>(res).content,
  };
}
