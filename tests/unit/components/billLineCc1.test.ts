import { describe, expect, it } from 'vitest';
import { deriveLineCc1, type LadderCentre } from '@/components/accounting/suppliers/billLineCc1';

const c = (id: string, ccType: string, parentId: string | null, isActive = true): LadderCentre =>
  ({ id, code: id.toUpperCase(), name: `Name ${id}`, ccType, parentId, isActive });

const ladder: LadderCentre[] = [
  c('f1', 'cc1', null), c('f2', 'cc1', null, false),
  c('p1', 'cc2', 'f1'), c('p2', 'cc2', 'p1'), c('orphan', 'cc2', null), c('loop', 'cc2', 'loop2'), c('loop2', 'cc2', 'loop'),
];

describe('deriveLineCc1', () => {
  it('derives the FNO from a CC2 directly under it', () => {
    expect(deriveLineCc1({ cc2Id: 'p1' }, ladder, '')).toBe('F1 Name f1');
  });
  it('walks a programme chain to the FNO', () => {
    expect(deriveLineCc1({ cc2Id: 'p2' }, ladder, '')).toBe('F1 Name f1');
  });
  it('is null for a CC2 whose chain reaches no FNO, even with a supplier default', () => {
    expect(deriveLineCc1({ cc2Id: 'orphan' }, ladder, 'f1')).toBeNull();
    expect(deriveLineCc1({ cc2Id: 'loop' }, ladder, '')).toBeNull();
  });
  it('keeps a CC1 the line already names (a copied PO line)', () => {
    expect(deriveLineCc1({ cc1Id: 'f1' }, ladder, '')).toBe('F1 Name f1');
  });
  it('falls back to the supplier default FNO for a line with no project', () => {
    expect(deriveLineCc1({}, ladder, 'f1')).toBe('F1 Name f1');
  });
  it('ignores an inactive or unknown supplier default FNO, as the server does', () => {
    expect(deriveLineCc1({}, ladder, 'f2')).toBeNull();
    expect(deriveLineCc1({}, ladder, 'nope')).toBeNull();
  });
  it('is null when nothing names a CC1', () => {
    expect(deriveLineCc1({}, ladder, '')).toBeNull();
    expect(deriveLineCc1({ cc2Id: '' }, [], '')).toBeNull();
  });
});
