import { describe, it, expect } from 'vitest';
import { attachNotes } from '@/modules/accounting/services/reports/statementRows/attachNotes';
import type { StatementRow } from '@/modules/accounting/services/reports/statementRows/statementModel';
import type { Annotation } from '@/modules/accounting/services/annotations/annotationService';

const rows: StatementRow[] = [
  { id: 'line:4000', kind: 'line', label: 'Sales', depth: 1, accountCode: '4000', actual: 100 },
  { id: 'line:5000', kind: 'line', label: 'Cost', depth: 1, accountCode: '5000', actual: 60 },
];

const ann = (id: string, rowId: string, resolvedAt: string | null): Annotation => ({
  id, rowId, periodStart: '2026-03-01', periodEnd: '2026-08-31',
  body: 'note', author: 'u1', authorName: 'A', createdAt: '2026-09-01T00:00:00Z', resolvedAt,
});

describe('attachNotes', () => {
  it('counts annotations onto the matching row only', () => {
    const out = attachNotes(rows, [ann('a', 'line:4000', null), ann('b', 'line:4000', null)]);
    expect(out[0]!.note).toEqual({ count: 2, hasOpen: true });
    expect(out[1]!.note).toBeUndefined();
  });

  it('reports hasOpen false when every annotation on the row is resolved', () => {
    const out = attachNotes(rows, [ann('a', 'line:4000', '2026-09-02T00:00:00Z')]);
    expect(out[0]!.note).toEqual({ count: 1, hasOpen: false });
  });

  it('returns new row objects and does not mutate the input', () => {
    const out = attachNotes(rows, [ann('a', 'line:4000', null)]);
    expect(rows[0]!.note).toBeUndefined();
    expect(out[0]).not.toBe(rows[0]);
  });

  it('ignores an annotation whose rowId matches nothing', () => {
    const out = attachNotes(rows, [ann('a', 'line:9999', null)]);
    expect(out.every(r => r.note === undefined)).toBe(true);
  });

  it('changes no figure on any row', () => {
    const out = attachNotes(rows, [ann('a', 'line:4000', null)]);
    expect(out.map(r => r.actual)).toEqual([100, 60]);
  });
});
