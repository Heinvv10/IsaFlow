/**
 * K-043 round 2 (LOW-7): `mapRequest` read `ruleId: String(r.rule_id)`, so a
 * NULL `rule_id` — nullable on the live schema, and what every request written
 * before requestApproval's scoped INSERT ... SELECT can carry — reached the
 * approvals page as the string "null". Every sibling field in the same mapper
 * already handled NULL explicitly.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({
  sql: Object.assign(() => Promise.resolve([]), { transaction: () => {}, unsafe: (s: string) => s }),
  withTransaction: () => {},
  fmtDate: (d: unknown) => String(d),
}));
vi.mock('@/lib/logger', () => ({ log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));

import { mapRequest } from '@/modules/accounting/services/gl/approvalMatching';

const base = {
  id: 'req-1', document_type: 'payment', document_id: 'doc-1', document_reference: null,
  amount: null, status: 'pending', requested_by: 'user-1', requested_at: '2026-09-01',
  decided_by: null, decided_at: null, decision_notes: null,
};

describe('mapRequest — nullable rule_id', () => {
  it('keeps a NULL rule_id as null, not the string "null"', () => {
    const mapped = mapRequest({ ...base, rule_id: null });
    expect(mapped.ruleId).toBeNull();
    expect(mapped.ruleId).not.toBe('null');
  });

  it('still passes a real rule_id through as a string', () => {
    expect(mapRequest({ ...base, rule_id: 'rule-1' }).ruleId).toBe('rule-1');
  });

  it('leaves the other nullable columns null as before', () => {
    const mapped = mapRequest({ ...base, rule_id: null });
    expect(mapped.decidedBy).toBeNull();
    expect(mapped.documentReference).toBeNull();
    expect(mapped.amount).toBeNull();
  });
});
