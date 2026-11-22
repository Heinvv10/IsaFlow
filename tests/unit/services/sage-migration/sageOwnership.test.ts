/** #1: the dry run's item outcomes are checked against what the snapshot said the migration owns (the plan was made from that snapshot). */
import { describe, expect, it } from 'vitest';
import { ownershipProblem } from '@/modules/accounting/services/sage-migration/sageOwnership';
import type { BatchReport } from '@/modules/accounting/services/sage-migration/sageMigrationTypes';

const owned = (ref: string) => ({ id: `i${ref}`, code: `C${ref}`, system: 'sage', ref, deleted: false, itemType: 'physical', inventoryTracked: false, hasMovements: false });
const batch = (rows: Array<Record<string, unknown>> | null): BatchReport =>
  ({ entity: 'item', n: 1, size: 2, key: 'k', status: 'ok', allRowsAlreadyPresent: false, rowsAbsent: 0, toolReported: rows ? { rows } : null, error: null });
const planned = [{ sageId: '1', code: 'C1' }, { sageId: '2', code: 'C2' }];

describe('ownershipProblem', () => {
  it('created for a Sage id the migration does not hold, updated/unchanged for one it owns: no problem', () => {
    const before = { items: [owned('2')] };
    expect(ownershipProblem(batch([{ index: 0, outcome: 'created' }, { index: 1, outcome: 'updated' }]), planned, before)).toBeNull();
    expect(ownershipProblem(batch([{ index: 0, outcome: 'created' }, { index: 1, outcome: 'unchanged' }]), planned, before)).toBeNull();
  });
  it('updated or unchanged for an id the snapshot did not show as owned: the row is named, another writer got in', () => {
    const p = ownershipProblem(batch([{ index: 0, outcome: 'updated' }, { index: 1, outcome: 'created' }]), planned, { items: [] });
    expect(p).toMatch(/row 0 \(C1, Sage id 1\)/);
    expect(p).toMatch(/updated/);
    expect(p).toMatch(/not an item this migration owns.*since the snapshot/);
  });
  it('created for an id the snapshot shows as owned: also a change since the snapshot', () => {
    expect(ownershipProblem(batch([{ index: 1, outcome: 'created' }]), planned, { items: [owned('2')] })).toMatch(/row 1 \(C2, Sage id 2\).*created.*already/);
  });
  it('a deleted owned item is not owned; an item of another system with the same ref is not owned', () => {
    expect(ownershipProblem(batch([{ index: 0, outcome: 'updated' }]), planned, { items: [{ ...owned('1'), deleted: true }] })).not.toBeNull();
    expect(ownershipProblem(batch([{ index: 0, outcome: 'updated' }]), planned, { items: [{ ...owned('1'), system: 'Sage' }] })).not.toBeNull();
  });
  it('a failed batch (no answer) has nothing to check', () => {
    expect(ownershipProblem(batch(null), planned, { items: [] })).toBeNull();
  });
  it('reports the first row wrong', () => {
    const p = ownershipProblem(batch([{ index: 0, outcome: 'updated' }, { index: 1, outcome: 'updated' }]), planned, { items: [] });
    expect(p).toMatch(/row 0/);
  });
});
