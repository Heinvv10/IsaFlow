/**
 * take_audit_snapshot's dry run: every refusal a manual take makes before it writes — no signing key, the company's
 * snapshot already being taken (it holds the same slot, briefly), over the size cap — and how many posted lines the
 * snapshot would freeze. Writes nothing. A dry run that passed where the take refuses would be worse than none.
 */
import { signingKey } from './seal';
import { countPostedLines } from './snapshotRows';
import { MAX_SNAPSHOT_LINES, SnapshotTooLargeError } from './snapshotService';
import { withSnapshotSlot } from './snapshotSlots';

export interface SnapshotPreview { cutoff: string; lines: number; maxLines: number }

export async function previewSnapshot(companyId: string, cutoff: string): Promise<SnapshotPreview> {
  signingKey();
  return withSnapshotSlot(companyId, false, async () => {
    const lines = await countPostedLines(companyId, cutoff);
    if (lines > MAX_SNAPSHOT_LINES) throw new SnapshotTooLargeError(lines, MAX_SNAPSHOT_LINES);
    return { cutoff, lines, maxLines: MAX_SNAPSHOT_LINES };
  });
}
