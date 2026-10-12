/**
 * Automatic snapshot attempts that freeze nothing new: 'failed' (with why) and 'unchanged' (pointing at the sealed
 * snapshot at the same cutoff whose ledger — every journal and line material hash and the trial balance — reads the
 * same today: closing then locking a period, or closing it again after a reopen, does not store a second copy).
 * Neither carries rows or a seal; the snapshots list shows both.
 */
import { runAuditTx, transactionNow, type AuditPrincipal } from './auditTx';
import { SNAPSHOT_CAVEAT, ledgerFingerprint } from './documents';
import { journalRows, lineRows, tbRows } from './snapshotRows';
import type { SnapshotTrigger } from './snapshotService';
import { verifySnapshot } from './snapshotVerify';

type AutoTrigger = Exclude<SnapshotTrigger, 'manual'>;

export async function recordSnapshotAttempt(p: AuditPrincipal, input: {
  cutoff: string; trigger: AutoTrigger; status: 'failed'; reason: string;
} | { cutoff: string; trigger: AutoTrigger; status: 'unchanged'; sameAs: string }): Promise<string> {
  return runAuditTx(p, 'READ COMMITTED', async (client) => {
    const id = crypto.randomUUID();
    await client.query('SELECT public.audit_snapshot_record($1::jsonb, $2::jsonb, $3::jsonb, $4::jsonb)', [
      JSON.stringify({
        id, company_id: p.companyId, cutoff: input.cutoff, taken_at: await transactionNow(client), taken_by: p.userId,
        trigger: input.trigger, status: input.status, failure_reason: input.status === 'failed' ? input.reason.slice(0, 500) : null,
        canonical_hash: null, hmac: null, key_id: null, master_data_high_water: null, totals: {}, caveat: SNAPSHOT_CAVEAT,
        check_run_id: null, same_as_snapshot_id: input.status === 'unchanged' ? input.sameAs : null,
      }), '[]', '[]', '[]',
    ]);
    return id;
  });
}

/**
 * The newest sealed snapshot at `cutoff` whose ledger still reads the same — and that verifies: an 'unchanged' row
 * vouches for the snapshot it points at, so a forged or altered one is never pointed at. Null otherwise.
 */
export async function unchangedSince(p: AuditPrincipal, cutoff: string): Promise<string | null> {
  return runAuditTx(p, 'REPEATABLE READ', async (client) => {
    const { rows: [s] } = await client.query<{ id: string; fy: string | null; fp: string | null }>(
      `SELECT id::text AS id, totals->>'fy_start' AS fy, totals->>'ledger_fingerprint' AS fp FROM audit_snapshots
       WHERE company_id = $1::uuid AND status = 'sealed' AND cutoff = $2::date ORDER BY seq DESC LIMIT 1`, [p.companyId, cutoff]);
    if (!s?.fp || !s.fy) return null;
    const live = ledgerFingerprint(await tbRows(p.companyId, cutoff, s.fy),
      await journalRows(p.companyId, cutoff), await lineRows(p.companyId, cutoff));
    if (live !== s.fp) return null;
    return (await verifySnapshot(p.companyId, s.id))?.status === 'valid' ? s.id : null;
  });
}
