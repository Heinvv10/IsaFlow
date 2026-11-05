// src/modules/accounting/services/afs/managementPackReads.ts
// How the generator reads a report for a pack section. A read that fails leaves its section saying so and
// does not stop the pack (the budget path's rule: a refusal is a warning, any other fault is also reported to
// Bugsink). The savepoint keeps a failed query from aborting the request's transaction, so each read runs
// alone and the reads of one section run one after another: none can land after a ROLLBACK TO.
import { log } from '@/lib/logger';
import { withSavepoint } from '@/lib/neon';
import { MissingSystemAccountError } from '../gl/systemAccountKeys';
import { capturePackFault } from './managementPackComparison';

/** The generator's logger component, which the log assertions and the log search both know. */
const COMPONENT = 'managementPackGeneratorService';

export async function readSafely<T>(
  ctx: { companyId: string; period: string },
  name: string,
  read: () => Promise<T>,
): Promise<T | null> {
  try {
    return await withSavepoint(`mgmt_pack_${name}`, read);
  } catch (err) {
    const fields = { ...ctx, statement: name, errorClass: err instanceof Error ? err.name : typeof err, error: err instanceof Error ? err.message : String(err) };
    if (err instanceof MissingSystemAccountError) {
      log.warn('management pack: a statement could not be read (no system account); its section says so', fields, COMPONENT);
    } else {
      log.error('management pack: a statement read failed; its section says so', fields, COMPONENT);
      capturePackFault(err, ctx.companyId);
    }
    return null;
  }
}
