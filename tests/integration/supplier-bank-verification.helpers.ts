/**
 * Fixture for the supplier bank-detail verification suites (forensic-controls
 * rebuild step 1): a payable company whose members are created per case, the
 * switch thrown through the REAL approval-enforcement route, bank details
 * changed through the real writer (updateSupplier, in a request transaction),
 * and the verify / state / outbound routes a person drives. Netcash is never
 * called: each suite mocks netcashService with a spy.
 */
import type { Pool } from 'pg';
import approvalEnforcement from '../../pages/api/accounting/approval-enforcement';
import supplierBankVerification from '../../pages/api/accounting/supplier-bank-verification';
import eftGenerate from '../../pages/api/accounting/eft-generate';
import netcashSubmit from '../../pages/api/accounting/netcash/submit';
import { updateSupplier } from '@/modules/accounting/services/core/supplierWriteService';
import { callRoute } from './r035-approval.helpers';
import { dataOf } from './r035-pr2.helpers';
import { inRequest, payCompany } from './r035-pr5.helpers';

type Tokens = Record<string, string>;

export interface BankState {
  enforced: boolean;
  state: 'verified' | 'unverified' | 'no_bank_details' | 'not_enforced';
  fingerprint: string | null;
  canVerify: boolean;
  latest: { kind: string; method: string | null; note: string | null; verifiedBy: string; verifiedAt: string } | null;
  history: { kind: string }[];
}

/** A payable company with Netcash switched on (keys present, so the spied client is what answers). */
export async function bankCompany(pool: Pool, members: [string, string][], companies: string[]) {
  const fx = await payCompany(pool, members, companies);
  await pool.query("UPDATE companies SET netcash_enabled = true, netcash_service_key = 'k', netcash_payouts_key = 'k' WHERE id = $1",
    [fx.company]);
  return fx;
}

export function bankRoutes(pool: Pool, tokens: Tokens) {
  const as = (user: string) => tokens[user]!;
  const r = {
    toggle: (user: string, c: string, enabled: boolean, token = as(user)) => callRoute(approvalEnforcement, token, c, 'POST',
      { documentType: 'supplier_bank_details', enabled }, '/api/accounting/approval-enforcement'),
    get: (user: string, c: string, supplierId: string) => callRoute(supplierBankVerification, as(user), c, 'GET', undefined,
      '/api/accounting/supplier-bank-verification', { supplierId }),
    state: async (user: string, c: string, supplierId: string) => {
      const res = await r.get(user, c, supplierId);
      if (res.state.statusCode !== 200) throw new Error(`state: ${JSON.stringify(res.state.body)}`);
      return dataOf<BankState>(res);
    },
    /** POST a verify. `fingerprint` defaults to the one `user` sees now — what the panel sends. */
    verify: async (user: string, c: string, supplierId: string, body: Record<string, unknown> = {}, token = as(user)) => {
      const seen = 'fingerprint' in body ? body.fingerprint : (await r.state(user, c, supplierId)).fingerprint;
      return callRoute(supplierBankVerification, token, c, 'POST', {
        supplierId, method: 'phone_known_number', note: 'Called the number on file and confirmed the account', ...body,
        fingerprint: seen,
      }, '/api/accounting/supplier-bank-verification');
    },
    eft: (user: string, c: string, batchId: string) => callRoute(eftGenerate, as(user), c, 'POST', { batchId, bank: 'fnb' },
      '/api/accounting/eft-generate'),
    netcash: (user: string, c: string, body: Record<string, unknown>) => callRoute(netcashSubmit, as(user), c, 'POST', body,
      '/api/accounting/netcash/submit'),
    /** `user` changes bank details through the real writer, as the UI route and MCP update_supplier do. */
    changeBank: (user: string, c: string, supplierId: string, change: Record<string, string>) =>
      inRequest(pool, user, c, () => updateSupplier(c, supplierId, change, user)),
  };
  return r;
}

export const verificationsOf = async (pool: Pool, supplierId: string) => (await pool.query(
  `SELECT kind, method, note, verified_by, fingerprint, roster_snapshot FROM supplier_bank_verifications
   WHERE supplier_id = $1 ORDER BY seq`, [supplierId])).rows as {
  kind: string; method: string | null; note: string | null; verified_by: string; fingerprint: string; roster_snapshot: unknown;
}[];

export const submissionsOf = async (pool: Pool, c: string) => (await pool.query(
  'SELECT count(*)::INT AS n FROM netcash_submissions WHERE company_id = $1', [c])).rows[0].n as number;

// No teardown of its own: PR5's cleanup deletes the suppliers, and their
// verifications go with them (ON DELETE CASCADE — the table is otherwise append-only).
