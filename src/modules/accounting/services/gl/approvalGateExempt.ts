/**
 * The declared import exemption from the supplier-invoice approval backstop
 * (R-035, decision Q1; migration 712's trigger reads it).
 *
 * The Sage staging import, the Sage migration commit and the AP take-on book
 * bills that were approved in the system they come from, straight into the AP
 * population. They — and only they — wrap that write in withApprovalGateExempt,
 * which sets the transaction-local `isaflow.approval_gate_exempt` to 'import'
 * for the write and clears it after. A census test pins the callers
 * (tests/unit/services/gl/approvalGateExemptCensus.test.ts): the GUC is a
 * setting any statement could set, so the control is who is allowed to.
 *
 * In a savepoint so that a throw reverts the setting with the write
 * (ROLLBACK TO undoes a set_config made after the savepoint) instead of
 * leaving the rest of the transaction exempt.
 */
import { sql, withSavepoint } from '@/lib/neon';

export async function withApprovalGateExempt<T>(write: () => Promise<T>): Promise<T> {
  return withSavepoint('approval_gate_exempt', async () => {
    await sql`SELECT set_config('isaflow.approval_gate_exempt', 'import', true)`;
    const result = await write();
    await sql`SELECT set_config('isaflow.approval_gate_exempt', '', true)`;
    return result;
  });
}
