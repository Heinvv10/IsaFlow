// RED phase — written before implementation
/**
 * Tests for the compliance work-items signal shaper and the aggregator's
 * work-item dedupe (which collapses the compliance VAT item against the
 * existing vatDueSignal item for the same company/task/due date).
 */

import { describe, it, expect } from 'vitest';
import {
  shapeCompliance,
  type ComplianceConfigRow,
} from '@/modules/bureau/services/complianceSignal';
import { dedupeWorkItems, type CompanyMeta, type WorkItem } from '@/modules/bureau/services/bureauWorkTypes';

const CO_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const CO_B = 'bbbbbbbb-0000-0000-0000-000000000002';

const META = new Map<string, CompanyMeta>([
  [CO_A, { bureau_id: 'bu1', bureau_name: 'Bureau One', company_id: CO_A, company_name: 'Alpha Ltd' }],
]);

const JUN_11 = new Date(Date.UTC(2026, 5, 11));

function row(overrides: Partial<ComplianceConfigRow> = {}): ComplianceConfigRow {
  return {
    company_id: CO_A,
    vat_enabled: false,
    emp201_enabled: false,
    emp501_enabled: false,
    provisional_tax_enabled: false,
    cipc_enabled: false,
    year_end_month: 2,
    cipc_anniversary_month: null,
    vat_period: 'bi-monthly',
    vat_period_alignment: 'odd',
    ...overrides,
  };
}

describe('shapeCompliance', () => {
  it('maps EMP201 obligations to work items with due date, href and severity', () => {
    const items = shapeCompliance([row({ emp201_enabled: true })], META, JUN_11);

    expect(items.length).toBe(3); // 7 Jul, 7 Aug, 7 Sep within 90 days
    const first = items[0]!;
    expect(first.companyId).toBe(CO_A);
    expect(first.companyName).toBe('Alpha Ltd');
    expect(first.bureauName).toBe('Bureau One');
    expect(first.task).toBe('EMP201 due');
    expect(first.detail).toBe('Jun 2026');
    expect(first.dueAt).toBe('2026-07-07');
    expect(first.href).toBe('/accounting/sars/emp201');
    expect(first.severity).toBe('info'); // 26 days out
  });

  it('derives the VAT cycle from the joined company columns', () => {
    const items = shapeCompliance(
      [row({ vat_enabled: true, vat_period: 'bi-monthly', vat_period_alignment: 'even' })],
      META,
      JUN_11,
    );
    expect(items.map((i) => i.dueAt)).toEqual(['2026-07-25']); // May–Jun, Cat B
    expect(items[0]!.task).toBe('VAT return due');
    expect(items[0]!.href).toBe('/accounting/sars/vat201');
  });

  it('drops rows whose company is not in the meta map (tenant guard)', () => {
    const items = shapeCompliance(
      [row({ company_id: CO_B, emp201_enabled: true })],
      META,
      JUN_11,
    );
    expect(items).toEqual([]);
  });

  it('marks an obligation due within 7 days as due_soon', () => {
    const jun20 = new Date(Date.UTC(2026, 5, 20));
    const items = shapeCompliance(
      [row({ vat_enabled: true })], // Cat A: due 25 Jun
      META,
      jun20,
    );
    expect(items[0]!.dueAt).toBe('2026-06-25');
    expect(items[0]!.severity).toBe('due_soon');
  });
});

describe('dedupeWorkItems', () => {
  const base: WorkItem = {
    bureauId: 'bu1', bureauName: 'Bureau One', companyId: CO_A, companyName: 'Alpha Ltd',
    task: 'VAT return due', detail: 'Apr–May 2026', dueAt: '2026-06-25',
    href: '/accounting/reports/vat-return', severity: 'info',
  };

  it('collapses items with the same company, task and due date, keeping the first', () => {
    const dupe: WorkItem = { ...base, href: '/accounting/sars/vat201' };
    const out = dedupeWorkItems([base, dupe]);
    expect(out).toHaveLength(1);
    expect(out[0]!.href).toBe('/accounting/reports/vat-return');
  });

  it('keeps items that differ in due date or task', () => {
    const later: WorkItem = { ...base, dueAt: '2026-08-25', detail: 'Jun–Jul 2026' };
    const otherTask: WorkItem = { ...base, task: 'EMP201 due' };
    expect(dedupeWorkItems([base, later, otherTask])).toHaveLength(3);
  });

  it('does not merge null due dates across different tasks', () => {
    const a: WorkItem = { ...base, dueAt: null, task: 'IRP5 readiness' };
    const b: WorkItem = { ...base, dueAt: null, task: 'Leave approvals' };
    expect(dedupeWorkItems([a, b])).toHaveLength(2);
  });
});
