import { randomUUID } from 'node:crypto';
import { als } from '@/lib/als';
import { assertControlTx, requireControlTx } from '@/modules/accounting/services/controls/context';
import { observeControlTransaction } from '@/modules/accounting/services/controls/transactionObservers';
import type { ControlTx } from '@/modules/accounting/services/controls/contracts';
import { captureInvocationIdentity, persistInvocationAdmission, persistInvocationOutcome, verifyInvocationOutcome } from './invocationPersistence';
import { INVOCATION_REASON_CODES, InvocationStoreError, type InvocationAdmissionInput, type InvocationCompletion } from './invocationTypes';
export type { InvocationAdmissionInput, InvocationCompletion, InvocationSummary } from './invocationTypes';
export { closeInvocationPool } from './invocationPersistence';
declare const handleBrand: unique symbol;
export interface InvocationHandle { readonly attemptId: string; readonly [handleBrand]: true }
interface Attempt { ctx: ControlTx; xid: string; completion: InvocationCompletion | null; settled: boolean }
const attempts = new WeakMap<InvocationHandle, Attempt>();
function poison(): void { const store = als.getStore(); if (store) store.controlWriteFailed = true; }
function validateAdmission(input: InvocationAdmissionInput): void {
  if (!input || !/^[a-z][a-z0-9_]{0,119}$/.test(input.tool) || !/^[a-f0-9]{64}$/.test(input.argsHash)
    || (input.idempotencyKeyHash !== null && !/^[a-f0-9]{64}$/.test(input.idempotencyKeyHash))) throw new InvocationStoreError();
}
function validateCompletion(input: InvocationCompletion): void {
  if (!input || !['ok','rejected','error','replay'].includes(input.status) || typeof input.reportedWrite !== 'boolean'
    || !Number.isSafeInteger(input.durationMs) || input.durationMs < 0 || input.durationMs > 86400000
    || (input.reasonCode !== undefined && !INVOCATION_REASON_CODES.includes(input.reasonCode))) throw new InvocationStoreError();
}
/** Must be awaited before any tool effect. The input contains no actor, payload, token or raw idempotency key. */
export async function beginMcpInvocation(input: InvocationAdmissionInput): Promise<InvocationHandle> {
  try {
    const ctx = requireControlTx(); validateAdmission(input);
    const admission = Object.freeze({tool:input.tool,argsHash:input.argsHash,idempotencyKeyHash:input.idempotencyKeyHash});
    const snapshot = captureInvocationIdentity(ctx);
    const [row] = await ctx.sql`SELECT pg_current_xact_id()::text AS xid` as { xid: string }[];
    if (!row || !/^[0-9]+$/.test(row.xid)) throw new InvocationStoreError();
    const handle = Object.freeze({ attemptId: randomUUID() }) as InvocationHandle;
    await persistInvocationAdmission(snapshot, admission, handle.attemptId, row.xid);
    const state: Attempt = { ctx, xid: row.xid, completion: null, settled: false };
    attempts.set(handle, state);
    observeControlTransaction(async outcome => {
      state.settled = true;
      // A committed outer transaction without its completion receipt does not certify tool completion.
      const proof = outcome === 'committed' ? await verifyInvocationOutcome(snapshot, handle.attemptId) :
        {outcome,completion:outcome === 'rolled_back' ? state.completion : null};
      await persistInvocationOutcome(snapshot, handle.attemptId, proof.outcome, proof.completion, 'observer');
    });
    return handle;
  } catch (error) { poison(); throw error; }
}
/** The receipt shares the real effect transaction; middleware alone reports its eventual commit outcome. */
export async function completeMcpInvocation(handle: InvocationHandle, input: InvocationCompletion): Promise<void> {
  try {
    const state = attempts.get(handle);
    if (!state || state.settled || state.completion) throw new InvocationStoreError();
    assertControlTx(state.ctx);
    if (requireControlTx().principal !== state.ctx.principal) throw new InvocationStoreError();
    validateCompletion(input);
    const completion = Object.freeze({ status: input.status, reportedWrite: input.reportedWrite, durationMs: input.durationMs,
      ...(input.reasonCode === undefined ? {} : { reasonCode: input.reasonCode }) });
    await state.ctx.sql`INSERT INTO mcp_invocation_receipts(company_id,attempt_id,outer_xid,status,reported_write,reason_code,duration_ms)
      VALUES(${state.ctx.principal.companyId}::uuid,${handle.attemptId}::uuid,${state.xid}::xid8,${completion.status},
        ${completion.reportedWrite},${completion.reasonCode ?? null},${completion.durationMs})`;
    state.completion = completion;
  } catch (error) { poison(); throw error; }
}
export {getMcpInvocationStatus,listMcpInvocations,reconcileMcpInvocation} from './invocationHistory';
