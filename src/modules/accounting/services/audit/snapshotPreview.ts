/**
 * take_audit_snapshot's dry run: the refusals a manual take makes before it writes — no signing key, the company's
 * snapshot already being taken (the same in-process slot and the same cross-process chain lock, each held only for
 * the count), over the size cap — and how many posted lines the snapshot would freeze, counted as the take counts
 * them: in the take's own kind of transaction (committed rows only, the audit statement cap). Writes nothing.
 * It cannot foresee the take running past its time budget (SNAPSHOT_TOO_SLOW). A dry run that passed where the take
 * refuses would be worse than none.
 */
import { signingKey } from './seal';
import { countPostedLines } from './snapshotRows';
import { MAX_SNAPSHOT_LINES, SnapshotTooLargeError } from './snapshotService';
import { withSnapshotSlot } from './snapshotSlots';
import { runAuditTx, type AuditPrincipal } from './auditTx';

export interface SnapshotPreview { cutoff: string; lines: number; maxLines: number }

export async function previewSnapshot(p: AuditPrincipal, cutoff: string): Promise<SnapshotPreview> {
  signingKey();
  return withSnapshotSlot(p.companyId, false, () => runAuditTx(p, 'READ COMMITTED', async () => {
    const lines = await countPostedLines(p.companyId, cutoff);
    if (lines > MAX_SNAPSHOT_LINES) throw new SnapshotTooLargeError(lines, MAX_SNAPSHOT_LINES);
    return { cutoff, lines, maxLines: MAX_SNAPSHOT_LINES };
  }, { chainLock: 'try' }));
}
