/**
 * WHICH failures inside the supplied-approval checks are the caller's.
 *
 * Marking anything without a SQLSTATE turned a stored-approval integrity trip
 * ('Approval material is invalid' — a tamper/canonicalisation detector) into a
 * 409 quoting it back, and unlogged. Only a declared refusal, or a SQLSTATE the
 * control functions RAISE on purpose, may be marked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
const q = vi.hoisted(() => ({ lock: vi.fn(), authorities: vi.fn(), decisions: vi.fn(), requesterAuthority: vi.fn(), validate: vi.fn() }));
vi.mock('@/lib/neon', () => ({ withSavepoint: (_name: string, run: () => unknown) => run() }));
vi.mock('@/modules/accounting/services/controls/context', () => ({ assertControlTx: vi.fn(), requireControlTx: vi.fn() }));
vi.mock('@/modules/accounting/services/controls/operationMaterializer', () => ({
  canonicalOperationRef: (ref: unknown) => ref,
  loadOperationMaterial: vi.fn(async () => ({ bindingHash: 'hash', binding: { policies: [] } })),
  materializeOperation: vi.fn(), reserveOperationExposure: vi.fn(),
}));
vi.mock('@/modules/accounting/services/controls/operationRequester', () => ({ assertOperationRequester: vi.fn() }));
vi.mock('@/modules/accounting/services/controls/approvalQueries', () => ({
  lockApproval: q.lock, approvalAuthorities: q.authorities, approvalDecisions: q.decisions,
  assertRequesterAuthority: q.requesterAuthority, validateDecisions: q.validate,
}));
import { assertSuppliedApprovalExecutable } from '@/modules/accounting/services/controls/approvalExecutionService';
import { SuppliedApprovalRefusal, isSuppliedApprovalRefusal, suppliedApprovalRefusalText } from '@/modules/accounting/services/controls/suppliedApprovalRefusal';
import type { ControlTx } from '@/modules/accounting/services/controls/contracts';

const ctx = { principal: { companyId: 'company', personId: 'person' }, sql: vi.fn(async () => []) } as unknown as ControlTx;
const ref = { entityType: 'fiscal_year', entityId: '2025', operation: 'year.close' as const };
async function refused(): Promise<unknown> {
  return assertSuppliedApprovalExecutable(ctx, ref, 'approval').then(() => null, (error: unknown) => error);
}
beforeEach(() => {
  vi.clearAllMocks();
  q.authorities.mockResolvedValue([]); q.decisions.mockResolvedValue([]);
  q.lock.mockResolvedValue({ id: 'approval', status: 'approved', unexpired: true, binding_hash: 'hash', requester_person_id: 'person' });
});

describe('what counts as a caller-supplied approval refusal', () => {
  it('marks a declared refusal', async () => {
    q.lock.mockRejectedValueOnce(new SuppliedApprovalRefusal('Approval not found'));
    expect(isSuppliedApprovalRefusal(await refused())).toBe(true);
  });
  it('does NOT mark a stored-approval integrity failure', async () => {
    q.lock.mockRejectedValueOnce(new Error('Approval material is invalid'));
    expect(isSuppliedApprovalRefusal(await refused())).toBe(false);
  });
  it('does NOT mark a programming failure in the same region', async () => {
    q.lock.mockRejectedValueOnce(new TypeError('x is not a function'));
    expect(isSuppliedApprovalRefusal(await refused())).toBe(false);
  });
  it('marks a SQLSTATE the control functions raise deliberately', async () => {
    q.authorities.mockRejectedValueOnce(Object.assign(new Error('Approval authorities unavailable'), { code: '42501' }));
    const error = await refused();
    expect(isSuppliedApprovalRefusal(error)).toBe(true);
    expect((error as { code?: string }).code, 'the SQLSTATE is preserved').toBe('42501');
  });
  it('does NOT mark a transport fault carrying its own SQLSTATE', async () => {
    q.authorities.mockRejectedValueOnce(Object.assign(new Error('deadlock detected'), { code: '40P01' }));
    expect(isSuppliedApprovalRefusal(await refused())).toBe(false);
  });
});

// A 42501 marks the refusal by SQLSTATE alone, and pg raises 42501 itself for a missing grant or a broken request
// context. Only text the control code wrote may reach the caller: a SuppliedApprovalRefusal, or a control function's
// own RAISE (pg reports routine exec_stmt_raise for a PL/pgSQL RAISE, aclcheck_error for "permission denied").
describe('what a caller is told about a supplied approval',()=>{
  it('repeats a control function\'s own RAISE',async()=>{
    q.authorities.mockRejectedValueOnce(Object.assign(new Error('Approval authorities unavailable'),{code:'42501',routine:'exec_stmt_raise'}));
    const error=await refused();
    expect(isSuppliedApprovalRefusal(error)).toBe(true);
    expect(suppliedApprovalRefusalText(error)).toBe('Approval authorities unavailable');
  });
  it('never echoes pg\'s own 42501 text, even though the SQLSTATE marks it',async()=>{
    q.authorities.mockRejectedValueOnce(Object.assign(new Error('permission denied for table control_operation_approvals'),{code:'42501',routine:'aclcheck_error'}));
    const error=await refused();
    expect(isSuppliedApprovalRefusal(error)).toBe(true);
    expect(suppliedApprovalRefusalText(error)).toBe('the approval could not be checked');
  });
  it('repeats a SuppliedApprovalRefusal written by the kernel',()=>{
    expect(suppliedApprovalRefusalText(new SuppliedApprovalRefusal('Approval material changed'))).toBe('Approval material changed');
  });
});
