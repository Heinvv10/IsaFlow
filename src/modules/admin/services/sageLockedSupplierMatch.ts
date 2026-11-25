/**
 * sagePartyMatch.resolveSageSupplier for a writer filing a bill (commitAPInvoice), with the match locked live. Its own file for
 * sagePartyMatch's 300-line cap.
 */
import { lockSupplierIfLive } from '@/modules/accounting/services/core/supplierLiveLock';
import { resolveSageSupplier, type SageSupplierMatch } from './sagePartyMatch';

/**
 * resolveSageSupplier for a writer filing a bill (commitAPInvoice): the match is locked FOR KEY SHARE and re-checked live
 * (supplierLiveLock; Codex gate at ecc452ea6b, finding 4). A merge that soft-deleted it after the match is waited for, and the party
 * is matched again (it then reaches the survivor); no merge can move it before the caller's transaction ends.
 */
export async function resolveLockedSageSupplier(
  companyId: string, party: { name: string; sageId?: number | string | null },
): Promise<SageSupplierMatch | null> {
  let match = await resolveSageSupplier(companyId, party);
  for (let attempt = 0; match && !(await lockSupplierIfLive(companyId, match.id)); attempt++) {
    if (attempt >= 2) throw new Error(`Sage supplier ${party.name}: merged again while importing; retry`);
    match = await resolveSageSupplier(companyId, party);
  }
  return match;
}
