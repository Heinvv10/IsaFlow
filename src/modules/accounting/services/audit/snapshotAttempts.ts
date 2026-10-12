/**
 * Automatic snapshot attempts that store no books: 'failed' (with why) and 'unchanged' (pointing at the sealed
 * snapshot at the same cutoff whose books — ledger, ageing and control totals — hash the same, with a sealed check
 * run of its own: closing then locking a period, or closing it again after a reopen, does not store a second copy).
 * Neither carries rows or a seal of its own; the snapshots list shows both.
 */
import type { PoolClient } from 'pg';
import { runAuditTx, transactionNow, type AuditPrincipal } from './auditTx';
import { SNAPSHOT_CAVEAT } from './documents';
import type { SnapshotTrigger } from './snapshotService';
import { verifySnapshot } from './snapshotVerify';
import { sealedChain } from './snapshotRead';
import { SNAPSHOT_SEAL_DOMAIN, checkSeal, type SigningKey } from './seal';

type AutoTrigger = Exclude<SnapshotTrigger, 'manual'>;
type Attempt = { cutoff: string; trigger: AutoTrigger; status: 'failed'; reason: string }
  | { cutoff: string; trigger: AutoTrigger; status: 'unchanged'; sameAs: string; checkRunId: string };

/** Records the attempt in the caller's audit transaction. */
export async function recordAttempt(client: PoolClient, p: AuditPrincipal, input: Attempt): Promise<string> {
  const id = crypto.randomUUID();
  await client.query('SELECT public.audit_snapshot_record($1::jsonb, $2::jsonb, $3::jsonb, $4::jsonb)', [
    JSON.stringify({
      id, company_id: p.companyId, cutoff: input.cutoff, taken_at: await transactionNow(client), taken_by: p.userId,
      trigger: input.trigger, status: input.status, failure_reason: input.status === 'failed' ? input.reason.slice(0, 500) : null,
      canonical_hash: null, hmac: null, key_id: null, master_data_high_water: null, totals: {}, caveat: SNAPSHOT_CAVEAT,
      check_run_id: input.status === 'unchanged' ? input.checkRunId : null,
      same_as_snapshot_id: input.status === 'unchanged' ? input.sameAs : null,
    }), '[]', '[]', '[]',
  ]);
  return id;
}

/** Records the attempt in a transaction of its own. */
export function recordSnapshotAttempt(p: AuditPrincipal, input: Attempt): Promise<string> {
  return runAuditTx(p, 'READ COMMITTED', (client) => recordAttempt(client, p, input));
}

/**
 * The newest sealed snapshot at `cutoff` whose books fingerprint is `fingerprint` — and that verifies: an
 * 'unchanged' row vouches for the snapshot it points at, so a forged or altered one is never pointed at, and a forged
 * row carrying the genuine fingerprint (readable in totals) does not hide the genuine one behind it. Each candidate's
 * seal is checked first (cheap: no rows), then the newest whose seal holds is verified in full. Null otherwise.
 * Read in the caller's snapshot transaction.
 */
export async function verifiedTwin(client: PoolClient, companyId: string, cutoff: string, fingerprint: string,
  key: SigningKey): Promise<string | null> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id::text AS id FROM audit_snapshots
     WHERE company_id = $1::uuid AND status = 'sealed' AND cutoff = $2::date AND totals->>'content_fingerprint' = $3
     ORDER BY seq DESC LIMIT 50`, [companyId, cutoff, fingerprint]);
  const sealed = new Map((await sealedChain(companyId)).map((l) => [l.id, l]));
  for (const { id } of rows) {
    const l = sealed.get(id);
    if (!l || checkSeal(SNAPSHOT_SEAL_DOMAIN, { companyId, id, canonicalHash: l.canonicalHash, cutoff: l.cutoff, takenAt: l.takenAt,
      chain: { seq: l.seq, prevHmac: l.prevHmac } }, l.hmac, l.keyId, key) !== 'valid') continue;
    if ((await verifySnapshot(companyId, id, key))?.status === 'valid') return id;
  }
  return null;
}

/** Whether the close / lock an automatic snapshot is for still stands — read in the caller's transaction. */
export async function lockStands(client: PoolClient, companyId: string, trigger: AutoTrigger, cutoff: string): Promise<boolean> {
  const { rows: [r] } = await client.query<{ ok: boolean }>(trigger === 'vat_lock'
    ? `SELECT EXISTS (SELECT 1 FROM vat_period_locks WHERE company_id = $1::uuid AND period_end = $2::date
         AND unlocked_at IS NULL) AS ok`
    : `SELECT EXISTS (SELECT 1 FROM fiscal_periods WHERE company_id = $1::uuid AND end_date = $2::date
         AND status IN ('closed', 'locked')) AS ok`, [companyId, cutoff]);
  return r?.ok === true;
}
