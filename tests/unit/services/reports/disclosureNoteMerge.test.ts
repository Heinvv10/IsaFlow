import { describe, expect, it } from 'vitest';
import { mergeDisclosureNotes } from '@/modules/accounting/services/reports/disclosureNoteMerge';
import type { DisclosureNote } from '@/modules/accounting/services/reports/disclosureNoteService';

const auto = (n: number): DisclosureNote => ({ noteNumber: n, title: `auto ${n}`, content: '', source: 'auto' });
const manual = (n: number, id = `m${n}`): DisclosureNote => ({ noteNumber: n, title: `manual ${n}`, content: '', source: 'manual', id });
const autos = (count: number) => Array.from({ length: count }, (_, i) => auto(i + 1));
const numbers = (notes: DisclosureNote[]) => notes.map((n) => `${n.source[0]}${n.noteNumber}`);

describe('mergeDisclosureNotes', () => {
  it('a normal year (7 generated notes): manual notes keep the numbers they were saved under', () => {
    expect(numbers(mergeDisclosureNotes(autos(7), [manual(8), manual(12)]))).toEqual(['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'm8', 'm12']);
  });

  it('a transition year (8 generated notes): a manual note saved as 8 moves to 9, and the ones after it keep their order', () => {
    const merged = mergeDisclosureNotes(autos(8), [manual(8), manual(9), manual(20)]);
    expect(numbers(merged)).toEqual(['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'm9', 'm10', 'm20']);
    expect(merged.filter((n) => n.source === 'manual').map((n) => n.id)).toEqual(['m8', 'm9', 'm20']);
  });

  it('every number in the merged list is unique, whatever the manual numbers', () => {
    const merged = mergeDisclosureNotes(autos(8), [manual(8), manual(8, 'again'), manual(9), manual(10)]);
    const all = merged.map((n) => n.noteNumber);
    expect(new Set(all).size).toBe(all.length);
  });

  it('does not change its inputs', () => {
    const m = [manual(8)];
    mergeDisclosureNotes(autos(8), m);
    expect(m[0]!.noteNumber).toBe(8);
  });

  it('no generated notes at all: manual notes are untouched', () => {
    expect(numbers(mergeDisclosureNotes([], [manual(8)]))).toEqual(['m8']);
  });
});
