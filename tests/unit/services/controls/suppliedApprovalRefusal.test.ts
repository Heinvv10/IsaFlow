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
import { SuppliedApprovalRefusal, isSuppliedApprovalRefusal } from '@/modules/accounting/services/controls/suppliedApprovalRefusal';
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
