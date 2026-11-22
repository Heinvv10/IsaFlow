/** Codex gate: the supplier POs report translates the statuses migration 1022 retired, and refuses one it cannot map. */
import { describe, expect, it } from 'vitest';
import { reportStatusFilter } from '@/modules/accounting/services/ap/supplierPoReportStatus';

describe('reportStatusFilter', () => {
  it('sent -> approved (what 1022 copied every sent order as)', () => {
    expect(reportStatusFilter('sent')).toEqual({ status: 'approved' });
  });
  it('a canonical status and no status pass as they are', () => {
    for (const s of ['draft', 'submitted', 'approved', 'partially_received', 'received', 'closed', 'cancelled']) expect(reportStatusFilter(s)).toEqual({ status: s });
    expect(reportStatusFilter(null)).toEqual({ status: null });
  });
  it('partially_invoiced (copied by quantity, no single status) and an unknown status are refused, naming the canonical ones', () => {
    // Breaker r12 F7: an Object.prototype key is not a retired status.
    for (const s of ['partially_invoiced', 'invoiced', 'shipped', 'constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      const r = reportStatusFilter(s);
      expect('refusal' in r && r.refusal).toContain('draft, submitted, approved, partially_received, received, closed, cancelled');
    }
    expect((reportStatusFilter('partially_invoiced') as { refusal: string }).refusal).toContain('retired');
    expect((reportStatusFilter('invoiced') as { refusal: string }).refusal).toContain('status invoiced was retired');
  });
});
