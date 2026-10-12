/**
 * A master integrity check that errors (count -1 from the runner) is recorded
 * `unknown`, never `pass`, and its savepoint is rolled back so the snapshot's
 * transaction survives it.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
const rolledBack: string[] = [];
vi.mock('@/lib/neon', () => ({
  withSavepoint: async (name: string, fn: () => Promise<unknown>) => {
    try { return await fn(); } catch (err) { rolledBack.push(name); throw err; }
  },
}));
vi.mock('@/modules/accounting/services/gl/integrityChecks', () => ({
  runIntegrityChecks: vi.fn(async (_c: string, o: { checks: string[] }) => ({
    checks: [o.checks[0] === 'duplicate_bank_references'
      ? { id: o.checks[0], label: 'x', severity: 'high', count: -1, amount: null, sample: [], finding: '' }
      : o.checks[0] === 'invoices_null_due_date'
        ? { id: o.checks[0], label: 'x', severity: 'high', count: 3, amount: 12.5, sample: [{ id: 'i1', label: 'INV-1', amount: 12.5 }], finding: '' }
        : { id: o.checks[0], label: 'x', severity: 'low', count: 0, amount: null, sample: [], finding: '' }],
  })),
}));

import { runIntegrity } from '@/modules/accounting/services/audit/checks/integrityAdapter';

describe('runIntegrity', () => {
  it('records all fifteen; an erroring check is unknown and its savepoint rolled back; counts are the runner\'s', async () => {
    const out = await runIntegrity({ companyId: 'c', from: '2026-01-01', to: '2026-06-30' });
    expect(out).toHaveLength(15);
    const by = Object.fromEntries(out.map((r) => [r.checkId, r]));
    expect(by['integrity.duplicate_bank_references']).toMatchObject({ status: 'unknown', findingCount: 0 });
    expect(rolledBack).toEqual(['audit_integrity_3']);
    expect(by['integrity.invoices_null_due_date']).toMatchObject({ status: 'fail', findingCount: 3,
      findings: [{ key: 'invoices_null_due_date:i1', refs: ['i1'], detail: { label: 'INV-1', amount: '12.50', detail: null } }] });
    expect(out.filter((r) => r.status === 'pass')).toHaveLength(13);
  });
});
