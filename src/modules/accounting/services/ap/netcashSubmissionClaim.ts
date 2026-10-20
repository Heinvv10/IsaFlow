/**
 * The durable claim on a supplier payment batch's Netcash submission (AP-01).
 *
 * A batch must go to Netcash once. The claim row (netcash_submissions, status
 * 'pending', batch_id; at most one non-failed row per batch by migration 898)
 * is written in its OWN committed transaction BEFORE the send, and settled in
 * another AFTER it. It must not live in the request's transaction: withAuth
 * rolls that back on any >=500 and on a crash or timeout, and with it the only
 * record that the batch may already have been paid.
 *
 * Each step is its own pooled connection (never the request's; the same shape
 * as audit/auditTx.runAuditTx), as app_user with the caller's claims and active
 * company, so RLS binds it and every statement still carries its company_id.
 *
 * A claim left 'pending' (the process died between the send and the settle, or
 * the settle failed) blocks resubmission exactly like 'unknown': it is in the
 * partial unique index. An operator clears it once Netcash has been checked:
 *   UPDATE netcash_submissions SET status = 'failed'    WHERE id = <id>;  -- Netcash never got it: allows a resend
 *   UPDATE netcash_submissions SET status = 'submitted' WHERE id = <id>;  -- Netcash has it: keeps the batch closed
 */
import type { PoolClient } from 'pg';
import { getPool } from '@/lib/neon';
import { log } from '@/lib/logger';
import { rollbackFailed } from '@/lib/rollbackFailed';

export interface ClaimPrincipal {
  companyId: string;
  /** The request's JWT claims: the RLS policies read the user from them. */
  claims: Record<string, unknown>;
}

export interface BatchClaim {
  batchId: string;
  batchReference: string | null;
  totalAmountCents: number;
  recordCount: number;
  createdBy: string;
}

export interface ClaimSettlement {
  status: 'submitted' | 'failed' | 'unknown';
  batchReference: string | null;
  netcashResponse: unknown;
  submittedAt: string | null;
}

/** One committed transaction on its own connection, as app_user in the caller's company. */
async function committed<T>(p: ClaimPrincipal, label: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  let unusable = false;
  let begun = false;
  try {
    await client.query('BEGIN');
    begun = true;
    await client.query('SET LOCAL ROLE app_user');
    await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify(p.claims)]);
    await client.query("SELECT set_config('app.current_company_id', $1, true)", [p.companyId]);
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    if (begun) unusable = await rollbackFailed(client, `netcash claim ${label}`);
    log.error('netcash claim transaction rolled back', {
      label, companyId: p.companyId, error: err instanceof Error ? err.message : String(err),
    }, 'netcash');
    throw err;
  } finally {
    client.release(unusable);
  }
}

/** Claim the batch: the new submission's id, or null when a live (non-failed) submission already holds it. */
export function claimBatch(p: ClaimPrincipal, c: BatchClaim): Promise<string | null> {
  return committed(p, 'claim', async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO netcash_submissions (
         company_id, submission_type, batch_reference, total_amount_cents, record_count, status, created_by, batch_id
       ) VALUES ($1::UUID, 'eft_payment', $2, $3, $4, 'pending', $5, $6::UUID)
       ON CONFLICT (company_id, batch_id) WHERE batch_id IS NOT NULL AND status <> 'failed' DO NOTHING
       RETURNING id`,
      [p.companyId, c.batchReference, c.totalAmountCents, c.recordCount, c.createdBy, c.batchId]);
    return rows[0]?.id ?? null;
  });
}

/** Record what Netcash answered on the claim. If this fails the claim stays 'pending', which keeps the batch closed. */
export function settleClaim(p: ClaimPrincipal, submissionId: string, s: ClaimSettlement): Promise<void> {
  return committed(p, 'settle', async (client) => {
    const { rowCount } = await client.query(
      `UPDATE netcash_submissions
       SET status = $3, batch_reference = $4, netcash_response = $5::JSONB, submitted_at = $6
       WHERE id = $1::UUID AND company_id = $2::UUID`,
      [submissionId, p.companyId, s.status, s.batchReference, JSON.stringify(s.netcashResponse), s.submittedAt]);
    if (rowCount !== 1) throw new Error(`netcash claim ${submissionId} not found for settlement`);
  });
}
