/** Adversarial (PR #1145 fix round): the strict overrides schema against what the codebase itself reads from overrides. */
import { describe, expect, it } from 'vitest';
import { sectionOverridesSchema } from '@/modules/accounting/services/afs/sectionOverridesSchema';

describe('strict overrides schema', () => {
  it('accepts note 26\'s nil-events confirmation, which complianceCheckerService reads from overrides.suppressReason', () => {
    // complianceCheckerService.ts:244-246: note26Valid when overrides.suppressReason === 'nil'; the overrides route is its only writer.
    expect(sectionOverridesSchema.safeParse({ suppressReason: 'nil' }).success).toBe(true);
  });
  it.each([
    ['generated content copied back', { title: 'Income Statement', blocks: [{ type: 'table', headers: ['', 'This month'], rows: [['Net profit', 'R 4.00']], rowKinds: ['total'] }, { type: 'heading', text: 'h', level: 2 }] }],
    ['empty', {}],
  ])('accepts %s', (_n, o) => expect(sectionOverridesSchema.safeParse(o).success).toBe(true));
  it.each([
    ['numeric title', { title: 123 }],
    ['null block', { blocks: [null] }],
    ['object cell', { blocks: [{ type: 'table', headers: ['a'], rows: [[{ x: 1 }]] }] }],
    ['hostile rowKind', { blocks: [{ type: 'table', headers: ['a'], rows: [['x']], rowKinds: ['total" onload="x'] }] }],
    ['unknown block type', { blocks: [{ type: 'chart', text: 'x' }] }],
    ['extra key on block', { blocks: [{ type: 'paragraph', text: 'x', html: '<b>' }] }],
    ['__proto__ key', JSON.parse('{"__proto__": {"title": 1}}')],
  ])('refuses %s', (_n, o) => expect(sectionOverridesSchema.safeParse(o).success).toBe(false));
});
