import { describe, it, expect } from 'vitest';
import { shapeBankQueries, type BankQueryCountRow } from '@/modules/bureau/services/bankQuerySignal';
import type { CompanyMeta } from '@/modules/bureau/services/bureauWorkTypes';

const TODAY = new Date('2026-06-11T08:00:00Z');
const META = new Map<string, CompanyMeta>([
  ['c1', { bureau_id: 'b1', bureau_name: 'Dotbiz', company_id: 'c1', company_name: 'Acme Trading' }],
]);

describe('shapeBankQueries', () => {
  it('emits a due_soon item when replies await review', () => {
    const rows: BankQueryCountRow[] = [{ company_id: 'c1', replied: 2, awaiting: 1, oldest_sent: '2026-06-10T00:00:00Z' }];
    const items = shapeBankQueries(rows, META, TODAY);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      companyId: 'c1', severity: 'due_soon', href: '/accounting/bank/queries',
    });
    expect(items[0]!.detail).toContain('2');
  });

  it('emits an info item when only stale (≥3 days) unanswered queries exist', () => {
    const rows: BankQueryCountRow[] = [{ company_id: 'c1', replied: 0, awaiting: 3, oldest_sent: '2026-06-01T00:00:00Z' }];
    const items = shapeBankQueries(rows, META, TODAY);
    expect(items).toHaveLength(1);
    expect(items[0]!.severity).toBe('info');
  });

  it('stays silent for fresh unanswered queries', () => {
    const rows: BankQueryCountRow[] = [{ company_id: 'c1', replied: 0, awaiting: 1, oldest_sent: '2026-06-10T12:00:00Z' }];
    expect(shapeBankQueries(rows, META, TODAY)).toHaveLength(0);
  });

  it('drops rows whose company is not in meta (tenant safety)', () => {
    const rows: BankQueryCountRow[] = [{ company_id: 'other', replied: 5, awaiting: 0, oldest_sent: null }];
    expect(shapeBankQueries(rows, META, TODAY)).toHaveLength(0);
  });

  it('handles Date objects for oldest_sent (pg returns Dates)', () => {
    const rows: BankQueryCountRow[] = [{ company_id: 'c1', replied: 0, awaiting: 2, oldest_sent: new Date('2026-06-01T00:00:00Z') }];
    const items = shapeBankQueries(rows, META, TODAY);
    expect(items).toHaveLength(1);
  });
});
