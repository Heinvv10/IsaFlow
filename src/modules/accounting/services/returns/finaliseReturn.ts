/** finaliseReturn: the entry point for L1a's route (wave 5). Judges everything before the first write. */
import { withSavepoint } from '@/lib/neon';
import { assertNotImpersonating } from '@/lib/auth/impersonationGuard';
import { finaliseVatReturn } from './finaliseVatReturn';
import { finaliseEmpReturn } from './finaliseEmpReturn';
import { listVersionRows } from './returnVersionStore';
import {
  ReturnRefusal, type FinaliseOptions, type ReturnActor, type ReturnForm, type ReturnVersion,
} from './returnVersionTypes';

export { ReturnRefusal } from './returnVersionTypes';

const PG_UNIQUE_VIOLATION = '23505';

export async function finaliseReturn(
  companyId: string, form: ReturnForm, periodStart: string, periodEnd: string,
  actor: ReturnActor, opts: FinaliseOptions = {},
): Promise<ReturnVersion> {
  await assertNotImpersonating(); // R-032: a filing control is refused to a Login-as session
  if (periodEnd < periodStart) throw new ReturnRefusal(400, 'periodEnd must not be before periodStart');

  const existing = await listVersionRows(companyId, form, periodStart, periodEnd);
  const current = existing.find((v) => v.status !== 'superseded');
  if (current) {
    throw new ReturnRefusal(409,
      `This ${form} is already ${current.status} as version ${current.versionNo}. Amend it before finalising again.`);
  }

  try {
    // One savepoint around the whole finalise: any refusal after a write (a lost race on the
    // unique index) leaves no lock, no override row and no version, even though a 4xx commits.
    return await withSavepoint('finalise_return', () => (form === 'VAT201'
      ? finaliseVatReturn(companyId, periodStart, periodEnd, actor, existing, opts)
      : finaliseEmpReturn(companyId, periodStart, periodEnd, actor, existing)));
  } catch (err) {
    if ((err as { code?: string }).code === PG_UNIQUE_VIOLATION) {
      throw new ReturnRefusal(409, `Another finalise of this ${form} just landed. Reload to see it.`);
    }
    throw err;
  }
}
